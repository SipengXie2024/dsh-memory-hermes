/**
 * Usage-telemetry seams: keep the sidecar's skill_usage table current with
 * REAL foreground use — the curator's lifecycle evidence.
 *
 * Two seams (both verified against dsh rc.6):
 * - `tools/result`: the model loaded a skill through dsh's stock `skill`
 *   tool. Emit semantics — a listener failure is swallowed by the registry
 *   and can never hurt the main loop.
 * - `session/event` `user/message` whose source is `skill-invocation`: the
 *   user invoked `/name` by hand (dsh's tool-skill injects that message).
 *
 * Maintenance reads inside the fork (skills_list / skill_view) deliberately
 * do NOT bump: counting them would mark every skill active on each pass and
 * blind the stale detector. The fork reads library files directly, so it
 * never enters either seam.
 *
 * Everything reads config at fire time — a settings commit toggles the
 * curator layer live.
 *
 * @module dsh-memory-hermes/curator/telemetry
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type { SkillTelemetry, SkillUsage } from '../reviewlog.js'
import type { ConfigSource } from '../settings.js'
import type { SkillMutationHooks } from '../skills/tools.js'

/** Fresh telemetry row for a skill first seen at `now`. */
export function seedUsage(now: number): SkillUsage {
  return { useCount: 0, firstSeenAt: now, state: 'active', pinned: false }
}

/** One observed use: count, timestamp, reactivate. */
export function bumpUsage(current: SkillUsage | undefined, now: number): SkillUsage {
  const base = current ?? seedUsage(now)
  return { ...base, useCount: base.useCount + 1, lastUsedAt: now, state: 'active' }
}

export interface TelemetryDeps {
  readonly telemetry: SkillTelemetry
  readonly configSource: ConfigSource
}

/**
 * Telemetry rides the fork's mutating actions: a created skill gets a fresh
 * row (createdAt set; any leftover from a same-named predecessor is reset —
 * inherited counts would poison the never-used grace), a deleted skill drops
 * its row. remove_file keeps the row: only a support file went away, the
 * skill itself is still in use.
 */
export function createSkillTelemetryHooks(deps: TelemetryDeps): SkillMutationHooks {
  return {
    onCreate: (name) => {
      if (!deps.configSource.get().curatorEnabled) return
      const now = Date.now()
      void deps.telemetry.update(name, () => ({ ...seedUsage(now), createdAt: now })).catch(() => {})
    },
    onDelete: (name) => {
      if (!deps.configSource.get().curatorEnabled) return
      void deps.telemetry.delete(name).catch(() => {})
    },
  }
}

export function installUsageTelemetry(ctx: Context, deps: TelemetryDeps): void {
  const bump = (name: string): void => {
    if (name === '') return
    if (!deps.configSource.get().curatorEnabled) return
    const now = Date.now()
    void deps.telemetry.update(name, current => bumpUsage(current, now)).catch(() => {})
  }
  ctx.on('tools/result', (exec, result) => {
    if (exec.name !== 'skill' || result.isError) return undefined
    const args = exec.arguments
    if (typeof args === 'object' && args !== null) {
      const name = (args as { name?: unknown }).name
      if (typeof name === 'string') bump(name)
    }
    return undefined
  })
  ctx.on('session/event', (_session, event) => {
    if (event.type !== 'user/message') return
    const source = (event.data as { source?: { kind?: unknown; name?: unknown } }).source
    if (source?.kind !== 'skill-invocation') return
    if (typeof source.name === 'string') bump(source.name)
  })
}
