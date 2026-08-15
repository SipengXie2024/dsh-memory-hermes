/**
 * Storage-domain sidecar (the messageFeedback precedent), now carrying three
 * things behind one shared domain open:
 *
 * - `runs`: the review/curator activity log — "did the background pass run,
 *   and what did it do" is answerable from the panel.
 * - `skill_usage`: per-skill usage telemetry (the curator's lifecycle
 *   evidence — use counts, timestamps, active/stale state, pins).
 * - global slot: curator scheduling state (`curatorLastRunAt`).
 *
 * The session log itself is off-limits — its event vocabulary is whitelisted
 * and a plugin-defined event type would make the whole log unreadable on
 * reload — so observability lives here: zod-validated KV tables with
 * durability-first writes and a free `domain/changed` emission per write.
 *
 * Read paths are in-memory mirrors (synchronous for the gateway and the
 * scheduler); writes persist through the domain's own write chain. Without
 * the storageDomain service everything degrades to memory-only. A domain can
 * only be opened once per process ("already open"), hence the single shared
 * open in `createSidecar`.
 *
 * @module dsh-memory-hermes/reviewlog
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/** What triggered one background pass. */
export type ReviewKind = 'turn' | 'compaction' | 'manual' | 'curator'

/** Per-run skill mutation tally (present when the skill route ran). */
export const skillActionCountsSchema = z.object({
  created: z.number().int(),
  updated: z.number().int(),
  patched: z.number().int(),
  deleted: z.number().int(),
  filesWritten: z.number().int(),
  filesRemoved: z.number().int(),
  skills: z.array(z.string()),
})
export type SkillActionCounts = z.infer<typeof skillActionCountsSchema>

/** One settled review pass; plain JSON, wire-safe as-is. */
export const reviewRunSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  /** Owning turn; -1 when the trigger has no turn (e.g. manual, curator). */
  turn: z.number().int(),
  kind: z.enum(['turn', 'compaction', 'manual', 'curator']),
  startedAt: z.number(),
  settledAt: z.number(),
  applied: z.number().int(),
  rejected: z.number().int(),
  malformed: z.number().int(),
  foreign: z.number().int(),
  /** Fork steps used (LLM calls in the loop). */
  steps: z.number().int().optional(),
  skillActions: skillActionCountsSchema.optional(),
  /** Per-step tool-call trace lines (bounded), for the activity tab. */
  trace: z.array(z.string()).optional(),
  /** Truncated text of each applied write. */
  entries: z.array(z.string()).optional(),
  /** Set when the pass failed or could not run at all. */
  error: z.string().optional(),
})
export type ReviewRun = z.infer<typeof reviewRunSchema>

/** One skill's usage telemetry row (keyed by skill name). */
export const skillUsageSchema = z.object({
  useCount: z.number().int(),
  /** Epoch ms of the last observed use. */
  lastUsedAt: z.number().optional(),
  /** Epoch ms when the fork created the skill (absent for adopted rows). */
  createdAt: z.number().optional(),
  /** Epoch ms when telemetry first saw the skill — the lifecycle clock anchor. */
  firstSeenAt: z.number(),
  state: z.enum(['active', 'stale']),
  pinned: z.boolean(),
})
export type SkillUsage = z.infer<typeof skillUsageSchema>

/** Curator scheduling state in the domain's global slot; 0 = never ran. */
export const curatorGlobalSchema = z.object({
  curatorLastRunAt: z.number(),
})
export type CuratorGlobal = z.infer<typeof curatorGlobalSchema>

/** Durable declaration of the plugin's sidecar domain. */
export const memoryHermesDomainSpec = defineDomain({
  // Backend unit names allow no dash (UNIT_NAME_RE), hence the underscores.
  name: 'memory_hermes',
  // Still version 1: same-version evolution is compatible — an added table
  // serves as empty on an old medium, and a missing global (the medium's
  // `null` sentinel) falls back to `initial`. Old sidecar files open as-is.
  version: 1,
  global: { schema: curatorGlobalSchema, initial: { curatorLastRunAt: 0 } },
  tables: {
    runs: domainTable<string, ReviewRun>(reviewRunSchema),
    skill_usage: domainTable<string, SkillUsage>(skillUsageSchema),
  },
})

export interface ReviewLog {
  record(run: ReviewRun): Promise<void>
  /** Newest first. */
  list(): readonly ReviewRun[]
  close(): Promise<void>
}

/** In-memory ring-bounded log; also the read mirror of the durable variant. */
export class MemoryReviewLog implements ReviewLog {
  protected readonly mirror = new Map<string, ReviewRun>()

  constructor(private readonly limit: () => number) {}

  /** Synchronous mirror update; returns the ids the ring cap evicted. */
  protected mirrorRecord(run: ReviewRun): string[] {
    this.mirror.set(run.id, run)
    const evicted: string[] = []
    const limit = Math.max(1, this.limit())
    while (this.mirror.size > limit) {
      const oldest = this.mirror.keys().next().value as string
      this.mirror.delete(oldest)
      evicted.push(oldest)
    }
    return evicted
  }

  async record(run: ReviewRun): Promise<void> {
    this.mirrorRecord(run)
  }

  list(): readonly ReviewRun[] {
    return [...this.mirror.values()].reverse()
  }

  async close(): Promise<void> {}
}

/** Structural views of the storage-domain seam (no runtime dependency). */
interface KvTableLike {
  entries(): IterableIterator<[string, unknown]>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
}

interface GlobalLike {
  get(): unknown
  set(value: unknown): Promise<void>
}

interface DomainLike {
  table(name: string): KvTableLike
  readonly global: GlobalLike
  close(): Promise<void>
}

interface StorageDomainLike {
  open(spec: unknown): Promise<DomainLike>
}

/**
 * Mirror-backed log persisting every run through a shared domain table.
 * `close` is the inherited no-op — the sidecar owner closes the domain.
 */
export class DomainReviewLog extends MemoryReviewLog {
  constructor(
    private readonly table: KvTableLike,
    limit: () => number,
    private readonly warn: (message: string) => void,
  ) {
    super(limit)
    // Seed the mirror with what the medium holds, oldest first so the ring
    // cap evicts correctly; overflow on the medium is trimmed best-effort.
    const persisted = [...table.entries()]
      .map(([, value]) => value as ReviewRun)
      .sort((a, b) => a.startedAt - b.startedAt)
    for (const run of persisted) {
      const evicted = this.mirrorRecord(run)
      for (const id of evicted) void table.delete(id).catch(() => {})
    }
  }

  override async record(run: ReviewRun): Promise<void> {
    const evicted = this.mirrorRecord(run)
    try {
      await this.table.put(run.id, run)
      for (const id of evicted) await this.table.delete(id)
    } catch (error) {
      // The mirror already holds the run; a persist failure must not break
      // the review loop that produced it.
      this.warn(`memory-hermes: review-log persist failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** Skill-usage telemetry face; keys are skill names. */
export interface SkillTelemetry {
  get(name: string): SkillUsage | undefined
  list(): ReadonlyMap<string, SkillUsage>
  /** Upsert through a mutator; `current` is undefined for a new row. */
  update(name: string, next: (current: SkillUsage | undefined) => SkillUsage): Promise<void>
  delete(name: string): Promise<void>
}

export class MemorySkillTelemetry implements SkillTelemetry {
  protected readonly mirror = new Map<string, SkillUsage>()

  get(name: string): SkillUsage | undefined {
    return this.mirror.get(name)
  }

  list(): ReadonlyMap<string, SkillUsage> {
    return this.mirror
  }

  async update(name: string, next: (current: SkillUsage | undefined) => SkillUsage): Promise<void> {
    this.mirror.set(name, next(this.mirror.get(name)))
  }

  async delete(name: string): Promise<void> {
    this.mirror.delete(name)
  }
}

/** Mirror-backed telemetry persisting through a shared domain table. */
export class DomainSkillTelemetry extends MemorySkillTelemetry {
  constructor(
    private readonly table: KvTableLike,
    private readonly warn: (message: string) => void,
  ) {
    super()
    for (const [name, value] of table.entries()) this.mirror.set(name, value as SkillUsage)
  }

  override async update(name: string, next: (current: SkillUsage | undefined) => SkillUsage): Promise<void> {
    await super.update(name, next)
    try {
      await this.table.put(name, this.mirror.get(name))
    } catch (error) {
      this.warn(`memory-hermes: skill-usage persist failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  override async delete(name: string): Promise<void> {
    await super.delete(name)
    try {
      await this.table.delete(name)
    } catch (error) {
      this.warn(`memory-hermes: skill-usage delete failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** Curator scheduling state; 0 = never ran (anchor before first pass). */
export interface CuratorState {
  lastRunAt(): number
  setLastRunAt(at: number): Promise<void>
}

export class MemoryCuratorState implements CuratorState {
  protected value = 0

  lastRunAt(): number {
    return this.value
  }

  async setLastRunAt(at: number): Promise<void> {
    this.value = at
  }
}

/** Curator state persisted in the shared domain's global slot. */
export class DomainCuratorState extends MemoryCuratorState {
  constructor(
    private readonly handle: GlobalLike,
    private readonly warn: (message: string) => void,
  ) {
    super()
    this.value = (this.handle.get() as CuratorGlobal).curatorLastRunAt
  }

  override async setLastRunAt(at: number): Promise<void> {
    await super.setLastRunAt(at)
    try {
      await this.handle.set({ curatorLastRunAt: at } satisfies CuratorGlobal)
    } catch (error) {
      // Memory keeps the value; losing durability means a restart may re-run
      // the curator early, which is safe (it snapshots before mutating).
      this.warn(`memory-hermes: curator-state persist failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** Stable facade over the sidecar (memory-only until the domain opens). */
export interface SidecarHandle {
  readonly log: ReviewLog
  listRuns(): Promise<readonly ReviewRun[]>
  readonly telemetry: SkillTelemetry
  readonly curatorState: CuratorState
}

export function createSidecar(
  ctx: Context,
  limit: () => number,
  warn: (message: string) => void,
): SidecarHandle {
  const logRef: { current: ReviewLog } = { current: new MemoryReviewLog(limit) }
  const telemetryRef: { current: SkillTelemetry } = { current: new MemorySkillTelemetry() }
  const stateRef: { current: CuratorState } = { current: new MemoryCuratorState() }
  const log: ReviewLog = {
    record: (run) => logRef.current.record(run),
    list: () => logRef.current.list(),
    close: () => logRef.current.close(),
  }
  const telemetry: SkillTelemetry = {
    get: (name) => telemetryRef.current.get(name),
    list: () => telemetryRef.current.list(),
    update: (name, next) => telemetryRef.current.update(name, next),
    delete: (name) => telemetryRef.current.delete(name),
  }
  const curatorState: CuratorState = {
    lastRunAt: () => stateRef.current.lastRunAt(),
    setLastRunAt: (at) => stateRef.current.setLastRunAt(at),
  }
  ctx.inject(['storageDomain'], (scoped) => {
    const facility = scoped.get('storageDomain') as StorageDomainLike | undefined
    if (facility === undefined || typeof facility.open !== 'function') return
    const ready = facility.open(memoryHermesDomainSpec)
      .then((domain) => {
        const domainLog = new DomainReviewLog(domain.table('runs'), limit, warn)
        // Migrate anything buffered while the domain was opening.
        const bufferedRuns = [...logRef.current.list()].reverse()
        logRef.current = domainLog
        for (const run of bufferedRuns) void domainLog.record(run).catch(() => {})
        const domainTelemetry = new DomainSkillTelemetry(domain.table('skill_usage'), warn)
        const bufferedRows = [...telemetryRef.current.list()]
        telemetryRef.current = domainTelemetry
        // Durable rows win; buffered rows only fill gaps (the pre-open
        // window is a few hundred ms at boot).
        for (const [name, row] of bufferedRows) {
          void domainTelemetry.update(name, current => current ?? row).catch(() => {})
        }
        const domainState = new DomainCuratorState(domain.global, warn)
        const bufferedAt = stateRef.current.lastRunAt()
        stateRef.current = domainState
        if (bufferedAt > domainState.lastRunAt()) void domainState.setLastRunAt(bufferedAt).catch(() => {})
        return domain
      })
      .catch((error: unknown) => {
        warn(`memory-hermes: review sidecar unavailable, memory-only: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      })
    scoped.effect(() => async () => {
      const domain = await ready
      if (domain !== undefined) await domain.close()
    }, 'memory-hermes: close sidecar domain')
  })
  return { log, listRuns: async () => log.list(), telemetry, curatorState }
}
