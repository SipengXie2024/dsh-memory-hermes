import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Resolved } from '../src/config.js'
import { Config } from '../src/config.js'
import { countLibrary, createSkillAdmin, renderCuratorOutcome, renderCuratorStatus } from '../src/curator/admin.js'
import type { CuratorOutcome } from '../src/curator/curator.js'
import { MemorySkillTelemetry } from '../src/reviewlog.js'
import { CuratorSkillStore } from '../src/skills/store.js'

const DAY = 86_400_000
const NOW = 1_755_000_000_000

let dir: string
let store: CuratorSkillStore
let telemetry: MemorySkillTelemetry

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-skill-admin-'))
  store = new CuratorSkillStore({ root: join(dir, 'skills'), maxFileBytes: 4096 })
  telemetry = new MemorySkillTelemetry()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const addUserSkill = (name: string): void => {
  const userDir = join(dir, 'skills', name)
  mkdirSync(userDir, { recursive: true })
  writeFileSync(join(userDir, 'SKILL.md'), `---\nname: ${name}\ndescription: hand made\n---\n# u\n`)
}

describe('createSkillAdmin', () => {
  it('pin seeds a missing row, flips the flag, and refuses unknown names', async () => {
    await store.create('pinnable', 'd', '# p\n')
    const admin = createSkillAdmin(store, telemetry)
    expect(await admin.pin('missing-skill', true)).toContain('not in the library')
    expect(await admin.pin('pinnable', true)).toContain('Pinned')
    expect(telemetry.get('pinnable')?.pinned).toBe(true)
    expect(await admin.pin('pinnable', false)).toContain('Unpinned')
    expect(telemetry.get('pinnable')?.pinned).toBe(false)
  })

  it('adopt returns the store outcome as reply text either way', async () => {
    addUserSkill('mine')
    const admin = createSkillAdmin(store, telemetry)
    expect(await admin.adopt('mine')).toContain('Adopted')
    expect(await admin.adopt('mine')).toContain('already curator-managed')
    expect(await admin.adopt('ghost')).toContain('not found')
  })

  it('list renders telemetry columns, lifecycle only for managed skills', async () => {
    await store.create('busy-skill', 'works hard', '# b\n')
    addUserSkill('idle-user-skill')
    await telemetry.update('busy-skill', () => ({ useCount: 4, lastUsedAt: NOW, firstSeenAt: NOW - 10 * DAY, state: 'stale', pinned: true }))
    const admin = createSkillAdmin(store, telemetry)
    const lines = await admin.list()
    expect(lines.find(line => line.startsWith('busy-skill'))).toBe('busy-skill: works hard [use=4 state=stale pinned]')
    expect(lines.find(line => line.startsWith('idle-user-skill'))).toBe('idle-user-skill: hand made (user-owned) [use=0]')
  })
})

describe('countLibrary', () => {
  it('splits managed/stale/pinned/user-owned', async () => {
    await store.create('active-one', 'd', '# a\n')
    await store.create('stale-one', 'd', '# s\n')
    await store.create('pinned-one', 'd', '# p\n')
    addUserSkill('theirs')
    await telemetry.update('stale-one', () => ({ useCount: 0, firstSeenAt: NOW - 90 * DAY, state: 'stale', pinned: false }))
    await telemetry.update('pinned-one', () => ({ useCount: 2, firstSeenAt: NOW, state: 'active', pinned: true }))
    expect(await countLibrary(store, telemetry)).toEqual({ managed: 3, stale: 1, pinned: 1, userOwned: 1 })
  })
})

describe('renderCuratorOutcome', () => {
  const outcome = (over: Partial<CuratorOutcome>): CuratorOutcome => ({ status: 'ran', ...over })

  it('covers every status shape', () => {
    expect(renderCuratorOutcome(undefined, true)).toContain('already in flight')
    expect(renderCuratorOutcome(outcome({ status: 'disabled' }), true)).toContain('curatorEnabled: false')
    expect(renderCuratorOutcome(outcome({ status: 'no-model', error: 'no model route: x' }), true)).toContain('no model route')
    expect(renderCuratorOutcome(outcome({ status: 'failed', error: 'boom' }), true)).toContain('boom')
  })

  it('explains why a sweep-only pass skipped consolidation', () => {
    const swept = outcome({ status: 'swept', sweep: { transitions: [], seeded: ['a'] } })
    expect(renderCuratorOutcome(swept, true)).toContain('nothing curator-managed')
    expect(renderCuratorOutcome(swept, false)).toContain('curatorConsolidate: false')
    expect(renderCuratorOutcome(swept, true)).toContain('1 row(s) seeded')
  })

  it('summarizes a full run with actions and the snapshot dir', () => {
    const ran = outcome({
      status: 'ran',
      steps: 5,
      backupDir: 'C:/backups/2026',
      skillActions: { created: 1, updated: 0, patched: 2, deleted: 1, filesWritten: 1, filesRemoved: 0, skills: ['umbrella-skill', 'old-skill'] },
    })
    const text = renderCuratorOutcome(ran, true)
    expect(text).toContain('5 step(s)')
    expect(text).toContain('created 1, updated 2, deleted 1')
    expect(text).toContain('umbrella-skill, old-skill')
    expect(text).toContain('C:/backups/2026')
  })
})

describe('renderCuratorStatus', () => {
  const config = new Config({}) as Resolved
  const counts = { managed: 2, stale: 1, pinned: 0, userOwned: 3 }

  it('renders the never-ran and anchored shapes', () => {
    const never = renderCuratorStatus({ running: false, lastRunAt: 0, lastActivityAt: NOW, nextEligibleAt: undefined }, config, counts)
    expect(never).toContain('never')
    expect(never).toContain('2 curator-managed (1 stale, 0 pinned), 3 user-owned')
    const anchored = renderCuratorStatus({ running: true, lastRunAt: NOW, lastActivityAt: NOW, nextEligibleAt: NOW + DAY }, config, counts)
    expect(anchored).toContain(new Date(NOW).toISOString())
    expect(anchored).toContain(new Date(NOW + DAY).toISOString())
    expect(anchored).toContain('in flight')
  })
})
