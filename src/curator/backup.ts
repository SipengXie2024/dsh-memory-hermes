/**
 * Pre-run safety net: a selective snapshot of everything the curator can
 * touch. Only curator-managed skill dirs are copied — user-owned skills are
 * never mutated by the fork, and leaving them out also keeps junction-linked
 * dirs away from fs.cp (managed dirs all come from store.create's mkdir, so
 * they are real directories). A JSON copy of the usage telemetry rides
 * along as the evidence of how skills were doing at snapshot time.
 *
 * Restore is manual: copy `<stamp>/<name>/` back into the skill root. Do
 * NOT restore old telemetry — a stale lastUsedAt would re-mark the skill
 * immediately; the next sweep re-seeds it with a fresh grace period.
 *
 * @module dsh-memory-hermes/curator/backup
 */

import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SkillTelemetry } from '../reviewlog.js'
import type { CuratorSkillStore } from '../skills/store.js'

/** Windows-safe snapshot dir name: ISO timestamp with `:`/`.` flattened. */
export function backupStamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-')
}

/** Only dirs shaped like our stamps participate in pruning. */
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/

export interface BackupDeps {
  readonly store: CuratorSkillStore
  readonly telemetry: SkillTelemetry
  /** Snapshot root, outside the skill library (e.g. `$DSH_HOME/skill-backups`). */
  readonly root: string
  readonly maxBackups: number
}

export interface BackupResult {
  /** Absolute snapshot dir; absent when nothing is curator-managed. */
  readonly dir?: string
  readonly skills: readonly string[]
  readonly prunedStamps: readonly string[]
}

/** Snapshot curator-managed skills + telemetry, then rotate old snapshots. */
export async function snapshotCuratorSkills(deps: BackupDeps, now: number): Promise<BackupResult> {
  const managed = (await deps.store.list()).filter(skill => skill.curatorManaged)
  if (managed.length === 0) return { skills: [], prunedStamps: [] }
  const dir = join(deps.root, backupStamp(now))
  await mkdir(dir, { recursive: true })
  for (const skill of managed) {
    await cp(skill.dir, join(dir, skill.name), {
      recursive: true,
      // The per-skill lock file is transient state, not skill content.
      filter: source => !source.endsWith('.skill.lock'),
    })
  }
  const rows = Object.fromEntries(deps.telemetry.list())
  await writeFile(join(dir, 'telemetry.json'), JSON.stringify(rows, null, 2), 'utf8')
  const prunedStamps = await pruneOldBackups(deps.root, deps.maxBackups)
  return { dir, skills: managed.map(skill => skill.name), prunedStamps }
}

/** Keep the newest `keep` stamp dirs (lexicographic = chronological). */
async function pruneOldBackups(root: string, keep: number): Promise<string[]> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const stamps = entries
    .filter(entry => entry.isDirectory() && STAMP_RE.test(entry.name))
    .map(entry => entry.name)
    .sort()
  const excess = stamps.slice(0, Math.max(0, stamps.length - Math.max(1, keep)))
  for (const stamp of excess) {
    await rm(join(root, stamp), { recursive: true, force: true })
  }
  return excess
}
