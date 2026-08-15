import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Resolved } from '../src/config.js'
import { CURATOR_PROMPT, curatorOnce, renderCandidateList, resolveCuratorRoute } from '../src/curator/curator.js'
import type { CuratorDeps } from '../src/curator/curator.js'
import { createSkillTelemetryHooks } from '../src/curator/telemetry.js'
import { MemorySkillTelemetry } from '../src/reviewlog.js'
import type { ReviewRun, SkillUsage } from '../src/reviewlog.js'
import { fixedConfigSource } from '../src/settings.js'
import { CuratorSkillStore } from '../src/skills/store.js'

const DAY = 86_400_000
const NOW = 1_755_000_000_000

let dir: string
let skillStore: CuratorSkillStore
let telemetry: MemorySkillTelemetry

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-curator-'))
  skillStore = new CuratorSkillStore({ root: join(dir, 'skills'), maxFileBytes: 65536 })
  telemetry = new MemorySkillTelemetry()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const DEFAULTS: Resolved = {
  memoryCharLimit: 2200,
  userCharLimit: 1375,
  securityScan: true,
  approval: false,
  backgroundReview: true,
  reviewMaxTokens: 1000,
  reviewTimeoutMs: 60_000,
  reviewTrigger: 'every-turn',
  reviewTokenDeltaTokens: 4000,
  compactionHarvest: true,
  reviewHistoryLimit: 200,
  consolidateMaxTokens: 2000,
  skillReview: true,
  reviewMaxSteps: 8,
  skillMaxBytes: 65536,
  curatorEnabled: true,
  curatorConsolidate: true,
  curatorIntervalHours: 168,
  curatorMinIdleHours: 2,
  curatorStaleAfterDays: 30,
  curatorMaxSteps: 16,
  curatorMaxTokens: 4000,
  curatorTimeoutMs: 300_000,
  curatorMaxBackups: 5,
}

// ---- chunk builders (mirroring review.test.ts) ---------------------------

const toolCallChunks = (index: number, args: unknown, name: string): unknown[] => [
  { type: 'block-start', index, blockType: 'tool-call' },
  {
    type: 'block-end',
    index,
    block: {
      type: 'tool-call',
      id: `call-${index}`,
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
  },
]

const textChunks = (index: number, text: string): unknown[] => [
  { type: 'block-start', index, blockType: 'text' },
  { type: 'block-end', index, block: { type: 'text', text } },
]

const finishChunk = (kind = 'tool-calls'): unknown[] => [
  {
    type: 'finish',
    reason: kind === 'error' || kind === 'aborted'
      ? { kind, failure: { reason: 'fake', message: 'boom' } }
      : { kind },
  },
]

const DONE = [...textChunks(9, 'library is class-shaped'), ...finishChunk('stop')]

function curatorCtx(script: readonly (readonly unknown[])[]) {
  const calls: Record<string, unknown>[] = []
  const warn = vi.fn()
  const ctx = {
    llm: {
      stream(options: Record<string, unknown>) {
        calls.push({ ...options, messages: [...(options.messages as unknown[])] })
        const chunks = script[Math.min(calls.length - 1, script.length - 1)]!
        return (async function* () { yield* chunks })()
      },
    },
    logger: { warn, info: vi.fn() },
  } as unknown as Context
  return { ctx, calls, warn }
}

const fakeReviewLog = () => {
  const runs: ReviewRun[] = []
  return {
    runs,
    log: {
      record: async (run: ReviewRun) => { runs.push(run) },
      list: () => [...runs].reverse(),
      close: async () => {},
    },
  }
}

function depsOf(over: Partial<Resolved> = {}, extras: Partial<CuratorDeps> = {}): CuratorDeps & { runs: ReviewRun[] } {
  const { runs, log } = fakeReviewLog()
  return {
    configSource: fixedConfigSource({ ...DEFAULTS, ...over }),
    skillStore,
    telemetry,
    reviewLog: log,
    backupRoot: join(dir, 'backups'),
    runs,
    ...extras,
  }
}

const signal = () => new AbortController().signal

// ---- prompt --------------------------------------------------------------

describe('CURATOR_PROMPT', () => {
  it('keeps the Hermes methodology core', () => {
    expect(CURATOR_PROMPT).toContain('UMBRELLA-BUILDING')
    expect(CURATOR_PROMPT).toContain('PREFIX CLUSTERS')
    expect(CURATOR_PROMPT).toContain('Package integrity')
    expect(CURATOR_PROMPT).toContain('pinned=yes')
    expect(CURATOR_PROMPT).toContain('use=0')
  })

  it('swaps archive semantics for permanent deletes with the snapshot net', () => {
    expect(CURATOR_PROMPT).toContain('PERMANENT')
    expect(CURATOR_PROMPT).toContain('pre-run snapshot')
    expect(CURATOR_PROMPT).toContain('viewed a skill')
    expect(CURATOR_PROMPT).not.toContain('.archive')
    expect(CURATOR_PROMPT).not.toContain('cron')
    expect(CURATOR_PROMPT).not.toContain('absorbed_into')
    expect(CURATOR_PROMPT).not.toContain('terminal')
  })

  it('drops the big-library aggressiveness calibration and adds the depth-1 rule', () => {
    expect(CURATOR_PROMPT).not.toContain('fewer than 10')
    expect(CURATOR_PROMPT).not.toContain('10-25 clusters')
    expect(CURATOR_PROMPT).toContain('one level deep')
    expect(CURATOR_PROMPT).toContain('library root')
  })
})

// ---- candidate list ------------------------------------------------------

describe('renderCandidateList', () => {
  it('names the empty library', () => {
    expect(renderCandidateList([], new Map())).toContain('empty')
  })

  it('renders managed rows with lifecycle columns and user rows without', async () => {
    await skillStore.create('managed-skill', 'fork made this', '# m\n')
    const userDir = join(dir, 'skills', 'user-skill')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, 'SKILL.md'), '---\nname: user-skill\ndescription: hand written\n---\n# u\n')
    const rows = new Map<string, SkillUsage>([
      ['managed-skill', { useCount: 3, lastUsedAt: NOW - DAY, firstSeenAt: NOW - 10 * DAY, state: 'stale', pinned: true }],
    ])
    const list = renderCandidateList(await skillStore.list(), rows)
    expect(list).toContain('- managed-skill  managed=yes  state=stale  pinned=yes  use=3')
    expect(list).toContain('— fork made this')
    expect(list).toContain('- user-skill  managed=no  use=0  last_used=never — hand written')
    expect(list).not.toContain('user-skill  managed=no  state=')
  })

  it('defaults telemetry-less managed rows to active/unpinned/never', async () => {
    await skillStore.create('fresh-skill', 'no telemetry yet', '# f\n')
    const list = renderCandidateList(await skillStore.list(), new Map())
    expect(list).toContain('- fresh-skill  managed=yes  state=active  pinned=no  use=0  last_used=never')
  })
})

// ---- model route ---------------------------------------------------------

describe('resolveCuratorRoute', () => {
  it('prefers the curator pair, then the review pair, then the default', () => {
    const withCurator = { ...DEFAULTS, curatorProvider: 'aux', curatorModel: 'small', reviewProvider: 'rev', reviewModel: 'mid' }
    expect(resolveCuratorRoute(withCurator)).toEqual({ provider: 'aux', model: 'small' })
    const withReview = { ...DEFAULTS, reviewProvider: 'rev', reviewModel: 'mid' }
    expect(resolveCuratorRoute(withReview)).toEqual({ provider: 'rev', model: 'mid' })
    expect(resolveCuratorRoute(DEFAULTS, () => ({ provider: 'main', model: 'big' }))).toEqual({ provider: 'main', model: 'big' })
    expect(resolveCuratorRoute(DEFAULTS)).toBeUndefined()
  })

  it('ignores a half-set pair', () => {
    const half = { ...DEFAULTS, curatorProvider: 'aux' }
    expect(resolveCuratorRoute(half, () => ({ provider: 'main', model: 'big' }))).toEqual({ provider: 'main', model: 'big' })
  })
})

// ---- curatorOnce ---------------------------------------------------------

describe('curatorOnce', () => {
  it('returns disabled without recording when the curator is off', async () => {
    const { ctx, calls } = curatorCtx([DONE])
    const deps = depsOf({ curatorEnabled: false })
    const outcome = await curatorOnce(ctx, deps, { signal: signal() })
    expect(outcome.status).toBe('disabled')
    expect(deps.runs).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  it('sweeps without an LLM when consolidation is off, and records the pass', async () => {
    await skillStore.create('aging-skill', 'd', '# a\n')
    await telemetry.update('aging-skill', () => ({ useCount: 1, lastUsedAt: NOW - 60 * DAY, firstSeenAt: NOW - 90 * DAY, state: 'active', pinned: false }))
    const { ctx, calls } = curatorCtx([DONE])
    const deps = depsOf({ curatorConsolidate: false, curatorProvider: 'aux', curatorModel: 'small' })
    const outcome = await curatorOnce(ctx, deps, { signal: signal(), now: NOW })
    expect(outcome.status).toBe('swept')
    expect(outcome.sweep?.transitions).toEqual([{ name: 'aging-skill', from: 'active', to: 'stale', neverUsed: false }])
    expect(calls).toHaveLength(0)
    expect(deps.runs).toHaveLength(1)
    expect(deps.runs[0]!.kind).toBe('curator')
    expect(deps.runs[0]!.turn).toBe(-1)
    expect(deps.runs[0]!.trace?.[0]).toContain('1 state transition(s)')
    expect(deps.runs[0]!.trace?.[1]).toContain('consolidation disabled')
    expect(existsSync(join(dir, 'backups'))).toBe(false)
  })

  it('skips consolidation when nothing is curator-managed', async () => {
    const userDir = join(dir, 'skills', 'only-user')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, 'SKILL.md'), '# no marker\n')
    const { ctx, calls } = curatorCtx([DONE])
    const deps = depsOf({ curatorProvider: 'aux', curatorModel: 'small' })
    const outcome = await curatorOnce(ctx, deps, { signal: signal(), now: NOW })
    expect(outcome.status).toBe('swept')
    expect(calls).toHaveLength(0)
    expect(deps.runs[0]!.trace?.[1]).toContain('no curator-managed skills')
  })

  it('records no-model when no route resolves (sweep still ran)', async () => {
    await skillStore.create('some-skill', 'd', '# s\n')
    const { ctx, calls } = curatorCtx([DONE])
    const deps = depsOf()
    const outcome = await curatorOnce(ctx, deps, { signal: signal(), now: NOW })
    expect(outcome.status).toBe('no-model')
    expect(outcome.sweep?.seeded).toEqual(['some-skill'])
    expect(calls).toHaveLength(0)
    expect(deps.runs[0]!.error).toContain('no model route')
    expect(existsSync(join(dir, 'backups'))).toBe(false)
  })

  it('runs the full pass: snapshot, cold prompt with the list, skill tools, sidecar record', async () => {
    await skillStore.create('existing-skill', 'already here', '# e\n')
    const hooks = createSkillTelemetryHooks({ telemetry, configSource: fixedConfigSource({ ...DEFAULTS }) })
    const { ctx, calls } = curatorCtx([
      [...toolCallChunks(0, { action: 'create', name: 'umbrella-skill', description: 'built by curator', content: '# Umbrella\n' }, 'skill_manage'), ...finishChunk()],
      DONE,
    ])
    const deps = depsOf({ curatorProvider: 'aux', curatorModel: 'small' }, { skillHooks: hooks })
    const outcome = await curatorOnce(ctx, deps, { signal: signal(), now: NOW })

    expect(outcome.status).toBe('ran')
    expect(outcome.steps).toBe(2)
    expect(outcome.skillActions?.created).toBe(1)
    expect(outcome.backupDir).toBe(join(dir, 'backups', new Date(NOW).toISOString().replace(/[:.]/g, '-')))

    // Cold input: one user message, no system, routed to the curator pair.
    expect(calls[0]!.provider).toBe('aux')
    expect(calls[0]!.model).toBe('small')
    expect(calls[0]!.system).toBeUndefined()
    expect(calls[0]!.sessionId).toBeUndefined()
    const first = (calls[0]!.messages as { content: { text: string }[] }[])[0]!
    expect(first.content[0]!.text).toContain('UMBRELLA-BUILDING')
    expect(first.content[0]!.text).toContain('- existing-skill  managed=yes')

    // The created skill landed with the marker and telemetry seeded via hooks.
    expect(readFileSync(join(dir, 'skills', 'umbrella-skill', 'SKILL.md'), 'utf8')).toContain('created_by: agent')
    expect(telemetry.get('umbrella-skill')?.createdAt).toBeDefined()

    // Snapshot preceded the mutation: it holds only the pre-existing skill.
    expect(existsSync(join(outcome.backupDir!, 'existing-skill', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(outcome.backupDir!, 'umbrella-skill'))).toBe(false)
    expect(existsSync(join(outcome.backupDir!, 'telemetry.json'))).toBe(true)

    expect(deps.runs).toHaveLength(1)
    const run = deps.runs[0]!
    expect(run.kind).toBe('curator')
    expect(run.sessionId).toBe('curator')
    expect(run.steps).toBe(2)
    expect(run.skillActions?.created).toBe(1)
    expect(run.trace?.[0]).toContain('sweep:')
    expect(run.trace?.[1]).toContain('snapshot: 1 skill(s)')
    expect(run.trace?.some(line => line.includes('skill_manage'))).toBe(true)
  })

  it('refuses foreign tools inside the pass and counts them', async () => {
    await skillStore.create('lone-skill', 'd', '# l\n')
    const { ctx } = curatorCtx([
      [...toolCallChunks(0, { file: 'memory', action: 'add', content: 'sneaky' }, 'memory'), ...finishChunk()],
      DONE,
    ])
    const deps = depsOf({ curatorProvider: 'aux', curatorModel: 'small' })
    const outcome = await curatorOnce(ctx, deps, { signal: signal(), now: NOW })
    expect(outcome.status).toBe('ran')
    expect(deps.runs[0]!.foreign).toBe(1)
    expect(deps.runs[0]!.trace?.some(line => line.includes('not available in the curator pass'))).toBe(true)
  })

  it('records a failed pass when the model call errors', async () => {
    await skillStore.create('doomed-skill', 'd', '# d\n')
    const { ctx, warn } = curatorCtx([finishChunk('error')])
    const deps = depsOf({ curatorProvider: 'aux', curatorModel: 'small' })
    const outcome = await curatorOnce(ctx, deps, { signal: signal(), now: NOW })
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('did not finish cleanly')
    expect(deps.runs[0]!.error).toContain('did not finish cleanly')
    expect(warn).toHaveBeenCalled()
  })
})
