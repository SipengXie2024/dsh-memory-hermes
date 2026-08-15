import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backupStamp, snapshotCuratorSkills } from '../src/curator/backup.js'
import { MemorySkillTelemetry } from '../src/reviewlog.js'
import { CuratorSkillStore } from '../src/skills/store.js'

const DAY = 86_400_000
const NOW = 1_755_000_000_000

let dir: string
let store: CuratorSkillStore
let telemetry: MemorySkillTelemetry

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-skill-backup-'))
  store = new CuratorSkillStore({ root: join(dir, 'skills'), maxFileBytes: 4096 })
  telemetry = new MemorySkillTelemetry()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const deps = (maxBackups = 5) => ({ store, telemetry, root: join(dir, 'backups'), maxBackups })

describe('backupStamp', () => {
  it('produces a Windows-safe chronological dir name', () => {
    const stamp = backupStamp(NOW)
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/)
    expect(stamp).not.toMatch(/[:.]/)
    expect(backupStamp(NOW + 1000) > stamp).toBe(true)
  })
})

describe('snapshotCuratorSkills', () => {
  it('copies only curator-managed skills plus a telemetry copy', async () => {
    await store.create('managed-one', 'd', '# one\n')
    await store.create('managed-two', 'd', '# two\n')
    await store.writeFile('managed-one', 'references/notes.md', 'ref body')
    const userDir = join(dir, 'skills', 'user-skill')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, 'SKILL.md'), '---\nname: user-skill\ndescription: mine\n---\n# hands off\n')
    await telemetry.update('managed-one', () => ({ useCount: 3, lastUsedAt: NOW - DAY, firstSeenAt: NOW - 10 * DAY, state: 'active', pinned: false }))

    const result = await snapshotCuratorSkills(deps(), NOW)
    expect(result.dir).toBe(join(dir, 'backups', backupStamp(NOW)))
    expect([...result.skills].sort()).toEqual(['managed-one', 'managed-two'])
    expect(result.prunedStamps).toEqual([])
    expect(readFileSync(join(result.dir!, 'managed-one', 'SKILL.md'), 'utf8')).toContain('created_by: agent')
    expect(readFileSync(join(result.dir!, 'managed-one', 'references', 'notes.md'), 'utf8')).toBe('ref body')
    expect(existsSync(join(result.dir!, 'user-skill'))).toBe(false)
    const rows = JSON.parse(readFileSync(join(result.dir!, 'telemetry.json'), 'utf8'))
    expect(rows['managed-one'].useCount).toBe(3)
  })

  it('excludes the transient per-skill lock file', async () => {
    await store.create('locked-skill', 'd', '# body\n')
    writeFileSync(join(dir, 'skills', 'locked-skill', '.skill.lock'), 'pid')
    const result = await snapshotCuratorSkills(deps(), NOW)
    expect(existsSync(join(result.dir!, 'locked-skill', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(result.dir!, 'locked-skill', '.skill.lock'))).toBe(false)
  })

  it('skips the snapshot entirely when nothing is curator-managed', async () => {
    const userDir = join(dir, 'skills', 'only-user')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, 'SKILL.md'), '# no marker\n')
    const result = await snapshotCuratorSkills(deps(), NOW)
    expect(result.dir).toBeUndefined()
    expect(result.skills).toEqual([])
    expect(existsSync(join(dir, 'backups'))).toBe(false)
  })

  it('rotates old snapshots, keeping maxBackups and ignoring foreign dirs', async () => {
    await store.create('rotating', 'd', '# body\n')
    mkdirSync(join(dir, 'backups', 'user-notes'), { recursive: true })
    const first = await snapshotCuratorSkills(deps(2), NOW)
    const second = await snapshotCuratorSkills(deps(2), NOW + 1000)
    const third = await snapshotCuratorSkills(deps(2), NOW + 2000)
    expect(first.prunedStamps).toEqual([])
    expect(second.prunedStamps).toEqual([])
    expect(third.prunedStamps).toEqual([backupStamp(NOW)])
    const remaining = readdirSync(join(dir, 'backups')).sort()
    expect(remaining).toEqual(['user-notes', backupStamp(NOW + 1000), backupStamp(NOW + 2000)].sort())
  })
})
