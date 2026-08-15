/**
 * Deterministic lifecycle layer: recompute each skill's active/stale state
 * from usage telemetry. A mark is evidence for the LLM consolidation pass,
 * never an action by itself — no file is touched here.
 *
 * Rules (Hermes apply_automatic_transitions, downshifted to two states):
 * - pinned skills are exempt from all automatic handling;
 * - used skills go stale when the last use falls out of the window;
 * - never-used skills get a grace period of one full window from first
 *   sight, and their staleness means evidence-absence, not obsolescence —
 *   the consolidation prompt carries that distinction.
 *
 * @module dsh-memory-hermes/curator/lifecycle
 */

import type { SkillTelemetry, SkillUsage } from '../reviewlog.js'
import { seedUsage } from './telemetry.js'

const DAY_MS = 86_400_000

export interface StaleVerdict {
  readonly state: 'active' | 'stale'
  /** Stale purely because the never-used grace expired. */
  readonly neverUsed: boolean
}

/** Pure classification of one telemetry row at `now`. */
export function classifyUsage(usage: SkillUsage, now: number, staleAfterDays: number): StaleVerdict {
  if (usage.pinned) return { state: 'active', neverUsed: false }
  const window = staleAfterDays * DAY_MS
  if (usage.useCount > 0) {
    // bumpUsage always sets lastUsedAt; the fallback covers hand-edited rows.
    const lastUsed = usage.lastUsedAt ?? usage.firstSeenAt
    return { state: now - lastUsed > window ? 'stale' : 'active', neverUsed: false }
  }
  const expired = now - usage.firstSeenAt > window
  return { state: expired ? 'stale' : 'active', neverUsed: expired }
}

export interface StaleTransition {
  readonly name: string
  readonly from: 'active' | 'stale'
  readonly to: 'active' | 'stale'
  readonly neverUsed: boolean
}

export interface LifecycleSweep {
  /** Rows whose state actually changed (both directions — a widened window
   * un-marks, a pin heals a previous mark). */
  readonly transitions: readonly StaleTransition[]
  /** Rows seeded for skills telemetry had never seen: pre-telemetry skills
   * and manual restores both enter the never-used grace afresh. */
  readonly seeded: readonly string[]
}

/**
 * Recompute state for the given (curator-managed) skill names, persisting
 * only rows that changed. Names without a telemetry row are seeded instead
 * of classified. Orphan rows (telemetry for skills no longer on disk) are
 * left alone — the delete hook owns that cleanup.
 */
export async function sweepLifecycle(
  telemetry: SkillTelemetry,
  names: readonly string[],
  now: number,
  staleAfterDays: number,
): Promise<LifecycleSweep> {
  const transitions: StaleTransition[] = []
  const seeded: string[] = []
  for (const name of names) {
    const current = telemetry.get(name)
    if (current === undefined) {
      await telemetry.update(name, existing => existing ?? seedUsage(now))
      seeded.push(name)
      continue
    }
    const verdict = classifyUsage(current, now, staleAfterDays)
    if (verdict.state === current.state) continue
    await telemetry.update(name, existing => ({ ...(existing ?? current), state: verdict.state }))
    transitions.push({ name, from: current.state, to: verdict.state, neverUsed: verdict.neverUsed })
  }
  return { transitions, seeded }
}
