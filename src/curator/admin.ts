/**
 * Operator-side curation surface: what the /memory subcommands delegate to.
 * Pin/unpin flips the telemetry exemption flag, adopt transfers
 * jurisdiction, and the renderers turn curator outcomes and scheduler
 * status into command-reply text.
 *
 * @module dsh-memory-hermes/curator/admin
 */

import type { Resolved } from '../config.js'
import type { SkillTelemetry } from '../reviewlog.js'
import type { CuratorSkillStore } from '../skills/store.js'
import type { CuratorOutcome } from './curator.js'
import type { CuratorStatus } from './scheduler.js'
import { seedUsage } from './telemetry.js'

export interface SkillAdmin {
  /** Flip the pin flag; returns the reply text. */
  pin(name: string, pinned: boolean): Promise<string>
  /** Transfer a user-owned skill into curator management. */
  adopt(name: string): Promise<string>
  /** `/memory skills` lines with telemetry columns. */
  list(): Promise<readonly string[]>
}

export function createSkillAdmin(store: CuratorSkillStore, telemetry: SkillTelemetry): SkillAdmin {
  return {
    async pin(name, pinned) {
      const skills = await store.list()
      if (!skills.some(skill => skill.name === name)) return `skill "${name}" is not in the library`
      await telemetry.update(name, current => ({ ...(current ?? seedUsage(Date.now())), pinned }))
      return pinned
        ? `Pinned "${name}" — exempt from stale marking and curator consolidation.`
        : `Unpinned "${name}" — back under normal curation.`
    },
    async adopt(name) {
      try {
        await store.adopt(name)
        return `Adopted "${name}" — now curator-managed (created_by: agent).`
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },
    async list() {
      const skills = await store.list()
      return skills.map((skill) => {
        const usage = telemetry.get(skill.name)
        const use = `use=${usage?.useCount ?? 0}`
        // Lifecycle columns only where a lifecycle exists (managed skills).
        const columns = skill.curatorManaged
          ? `${use} state=${usage?.state ?? 'active'}${usage?.pinned === true ? ' pinned' : ''}`
          : use
        return `${skill.name}: ${skill.description}${skill.curatorManaged ? '' : ' (user-owned)'} [${columns}]`
      })
    },
  }
}

export interface LibraryCounts {
  readonly managed: number
  readonly stale: number
  readonly pinned: number
  readonly userOwned: number
}

export async function countLibrary(store: CuratorSkillStore, telemetry: SkillTelemetry): Promise<LibraryCounts> {
  const skills = await store.list()
  let managed = 0
  let stale = 0
  let pinned = 0
  let userOwned = 0
  for (const skill of skills) {
    if (!skill.curatorManaged) {
      userOwned += 1
      continue
    }
    managed += 1
    const usage = telemetry.get(skill.name)
    if (usage?.state === 'stale') stale += 1
    if (usage?.pinned === true) pinned += 1
  }
  return { managed, stale, pinned, userOwned }
}

const iso = (ms: number): string => new Date(ms).toISOString()

/** `/memory curator` reply. */
export function renderCuratorOutcome(outcome: CuratorOutcome | undefined, consolidateEnabled: boolean): string {
  if (outcome === undefined) return 'A curator run is already in flight.'
  switch (outcome.status) {
    case 'disabled':
      return 'Curator is disabled (curatorEnabled: false).'
    case 'swept': {
      const sweep = outcome.sweep
      const detail = sweep === undefined ? '' : ` Sweep: ${sweep.transitions.length} state transition(s), ${sweep.seeded.length} row(s) seeded.`
      const why = consolidateEnabled ? 'nothing curator-managed to consolidate' : 'consolidation is off (curatorConsolidate: false)'
      return `Deterministic sweep done; ${why}.${detail}`
    }
    case 'no-model':
      return `Curator could not run the consolidation pass: ${outcome.error ?? 'no model route'}.`
    case 'failed':
      return `Curator run failed: ${outcome.error ?? 'unknown error'}.`
    case 'ran': {
      const actions = outcome.skillActions
      const touched = actions === undefined || actions.skills.length === 0
        ? 'no skills touched'
        : `created ${actions.created}, updated ${actions.updated + actions.patched}, deleted ${actions.deleted}, files ${actions.filesWritten}+/${actions.filesRemoved}- (${actions.skills.join(', ')})`
      const backup = outcome.backupDir === undefined ? '' : `\nSnapshot: ${outcome.backupDir}`
      return `Curator run finished in ${outcome.steps ?? 0} step(s): ${touched}.${backup}\nDetails are on the memory settings page activity tab.`
    }
  }
}

/** `/memory curator status` reply. */
export function renderCuratorStatus(status: CuratorStatus, config: Resolved, counts: LibraryCounts): string {
  const lines: string[] = []
  lines.push(`Curator: ${config.curatorEnabled ? 'enabled' : 'disabled'} (consolidation ${config.curatorConsolidate ? 'on' : 'off'}, interval ${config.curatorIntervalHours}h, idle gate ${config.curatorMinIdleHours}h, stale window ${config.curatorStaleAfterDays}d)`)
  lines.push(status.lastRunAt === 0
    ? 'Last run: never (the cycle anchors on the first hourly probe)'
    : `Last run: ${iso(status.lastRunAt)}`)
  if (status.nextEligibleAt !== undefined) {
    lines.push(`Next eligible: ${iso(status.nextEligibleAt)} (the idle gate must also be open)`)
  }
  lines.push(`Last user activity: ${iso(status.lastActivityAt)}`)
  if (status.running) lines.push('A curator run is in flight right now.')
  lines.push(`Library: ${counts.managed} curator-managed (${counts.stale} stale, ${counts.pinned} pinned), ${counts.userOwned} user-owned`)
  return lines.join('\n')
}
