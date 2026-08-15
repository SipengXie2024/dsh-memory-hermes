/**
 * Review-run activity log: a storage-domain sidecar (the messageFeedback
 * precedent) so "did the background review run, and what did it do" is
 * answerable from the panel. The session log itself is off-limits — its
 * event vocabulary is whitelisted and a plugin-defined event type would
 * make the whole log unreadable on reload — so observability lives here:
 * a zod-validated KV table with durability-first writes and a free
 * `domain/changed` emission per write.
 *
 * Read path is an in-memory mirror (synchronous list for the gateway);
 * writes persist through the domain's own write chain. Without the
 * storageDomain service the log degrades to memory-only.
 *
 * @module dsh-memory-hermes/reviewlog
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/** What triggered one background review pass. */
export type ReviewKind = 'turn' | 'compaction' | 'manual'

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
  /** Owning turn; -1 when the trigger has no turn (e.g. manual compaction). */
  turn: z.number().int(),
  kind: z.enum(['turn', 'compaction', 'manual']),
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

/** Durable declaration of the plugin's sidecar domain. */
export const memoryHermesDomainSpec = defineDomain({
  // Backend unit names allow no dash (UNIT_NAME_RE), hence the underscore.
  name: 'memory_hermes',
  version: 1,
  tables: {
    runs: domainTable<string, ReviewRun>(reviewRunSchema),
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
  put(key: string, value: ReviewRun): Promise<void>
  delete(key: string): Promise<boolean>
}

interface DomainLike {
  table(name: string): KvTableLike
  close(): Promise<void>
}

interface StorageDomainLike {
  open(spec: unknown): Promise<DomainLike>
}

/** Mirror-backed log persisting every run through the sidecar domain. */
export class DomainReviewLog extends MemoryReviewLog {
  private constructor(
    private readonly table: KvTableLike,
    private readonly domain: DomainLike,
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

  static async open(
    facility: StorageDomainLike,
    limit: () => number,
    warn: (message: string) => void,
  ): Promise<DomainReviewLog> {
    const domain = await facility.open(memoryHermesDomainSpec)
    return new DomainReviewLog(domain.table('runs'), domain, limit, warn)
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

  override async close(): Promise<void> {
    await this.domain.close()
  }
}

/** Stable facade over the current log (memory-only until the domain opens). */
export interface ReviewLogHandle {
  readonly log: ReviewLog
  listRuns(): Promise<readonly ReviewRun[]>
}

export function createReviewLog(
  ctx: Context,
  limit: () => number,
  warn: (message: string) => void,
): ReviewLogHandle {
  const ref: { current: ReviewLog } = { current: new MemoryReviewLog(limit) }
  const facade: ReviewLog = {
    record: (run) => ref.current.record(run),
    list: () => ref.current.list(),
    close: () => ref.current.close(),
  }
  ctx.inject(['storageDomain'], (scoped) => {
    const facility = scoped.get('storageDomain') as StorageDomainLike | undefined
    if (facility === undefined || typeof facility.open !== 'function') return
    const ready = DomainReviewLog.open(facility, limit, warn)
      .then((log) => {
        // Migrate anything buffered while the domain was opening.
        const buffered = [...ref.current.list()].reverse()
        ref.current = log
        for (const run of buffered) void log.record(run).catch(() => {})
        return log
      })
      .catch((error) => {
        warn(`memory-hermes: review sidecar unavailable, memory-only: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      })
    scoped.effect(() => async () => {
      const log = await ready
      if (log !== undefined) await log.close()
    }, 'memory-hermes: close review sidecar')
  })
  return { log: facade, listRuns: async () => facade.list() }
}
