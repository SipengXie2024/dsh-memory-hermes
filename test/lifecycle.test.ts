import { describe, expect, it } from 'vitest'
import { classifyUsage, sweepLifecycle } from '../src/curator/lifecycle.js'
import { MemorySkillTelemetry } from '../src/reviewlog.js'
import type { SkillUsage } from '../src/reviewlog.js'

const DAY = 86_400_000
const NOW = 1_000 * DAY

const row = (over: Partial<SkillUsage> = {}): SkillUsage => ({
  useCount: 0,
  firstSeenAt: NOW - 10 * DAY,
  state: 'active',
  pinned: false,
  ...over,
})

describe('classifyUsage', () => {
  it('keeps a recently used skill active', () => {
    const verdict = classifyUsage(row({ useCount: 5, lastUsedAt: NOW - 3 * DAY }), NOW, 30)
    expect(verdict).toEqual({ state: 'active', neverUsed: false })
  })

  it('marks a used skill stale once the last use falls out of the window', () => {
    const verdict = classifyUsage(row({ useCount: 5, lastUsedAt: NOW - 31 * DAY }), NOW, 30)
    expect(verdict).toEqual({ state: 'stale', neverUsed: false })
  })

  it('exactly-at-window is still active (strict >)', () => {
    const verdict = classifyUsage(row({ useCount: 1, lastUsedAt: NOW - 30 * DAY }), NOW, 30)
    expect(verdict.state).toBe('active')
  })

  it('gives a never-used skill one full window of grace from first sight', () => {
    expect(classifyUsage(row({ firstSeenAt: NOW - 29 * DAY }), NOW, 30).state).toBe('active')
    expect(classifyUsage(row({ firstSeenAt: NOW - 31 * DAY }), NOW, 30)).toEqual({ state: 'stale', neverUsed: true })
  })

  it('pinned skills are exempt no matter how old', () => {
    const verdict = classifyUsage(row({ pinned: true, firstSeenAt: NOW - 400 * DAY }), NOW, 30)
    expect(verdict).toEqual({ state: 'active', neverUsed: false })
  })

  it('falls back to firstSeenAt for a used row missing lastUsedAt', () => {
    const verdict = classifyUsage(row({ useCount: 3, firstSeenAt: NOW - 31 * DAY }), NOW, 30)
    expect(verdict).toEqual({ state: 'stale', neverUsed: false })
  })

  it('a zero-day window marks anything with elapsed time (live-test escape hatch)', () => {
    expect(classifyUsage(row({ useCount: 1, lastUsedAt: NOW - 1 }), NOW, 0).state).toBe('stale')
    expect(classifyUsage(row({ useCount: 1, lastUsedAt: NOW }), NOW, 0).state).toBe('active')
  })
})

/** MemorySkillTelemetry that counts which rows update() touched. */
class CountingTelemetry extends MemorySkillTelemetry {
  readonly touched: string[] = []

  override async update(name: string, next: (current: SkillUsage | undefined) => SkillUsage): Promise<void> {
    this.touched.push(name)
    await super.update(name, next)
  }
}

describe('sweepLifecycle', () => {
  it('persists only rows whose state changed and reports the transitions', async () => {
    const telemetry = new CountingTelemetry()
    await telemetry.update('fresh', () => row({ useCount: 2, lastUsedAt: NOW - 1 * DAY }))
    await telemetry.update('old', () => row({ useCount: 2, lastUsedAt: NOW - 60 * DAY }))
    telemetry.touched.length = 0
    const sweep = await sweepLifecycle(telemetry, ['fresh', 'old'], NOW, 30)
    expect(sweep.transitions).toEqual([{ name: 'old', from: 'active', to: 'stale', neverUsed: false }])
    expect(sweep.seeded).toEqual([])
    expect(telemetry.touched).toEqual(['old'])
    expect(telemetry.get('old')?.state).toBe('stale')
    expect(telemetry.get('fresh')?.state).toBe('active')
  })

  it('un-marks a stale row when the window widens (both directions converge)', async () => {
    const telemetry = new CountingTelemetry()
    await telemetry.update('was-stale', () => row({ useCount: 1, lastUsedAt: NOW - 40 * DAY, state: 'stale' }))
    const sweep = await sweepLifecycle(telemetry, ['was-stale'], NOW, 90)
    expect(sweep.transitions).toEqual([{ name: 'was-stale', from: 'stale', to: 'active', neverUsed: false }])
    expect(telemetry.get('was-stale')?.state).toBe('active')
  })

  it('a pin heals a previous stale mark on the next sweep', async () => {
    const telemetry = new CountingTelemetry()
    await telemetry.update('pinned-late', () => row({ firstSeenAt: NOW - 100 * DAY, state: 'stale', pinned: true }))
    const sweep = await sweepLifecycle(telemetry, ['pinned-late'], NOW, 30)
    expect(sweep.transitions[0]?.to).toBe('active')
    expect(telemetry.get('pinned-late')?.state).toBe('active')
  })

  it('seeds names telemetry never saw with a fresh grace period', async () => {
    const telemetry = new CountingTelemetry()
    const sweep = await sweepLifecycle(telemetry, ['restored-skill'], NOW, 30)
    expect(sweep.seeded).toEqual(['restored-skill'])
    expect(sweep.transitions).toEqual([])
    expect(telemetry.get('restored-skill')).toEqual({
      useCount: 0,
      firstSeenAt: NOW,
      state: 'active',
      pinned: false,
    })
  })

  it('leaves orphan telemetry rows alone (names drive the sweep)', async () => {
    const telemetry = new CountingTelemetry()
    await telemetry.update('orphan', () => row({ firstSeenAt: NOW - 400 * DAY }))
    telemetry.touched.length = 0
    const sweep = await sweepLifecycle(telemetry, [], NOW, 30)
    expect(sweep.transitions).toEqual([])
    expect(telemetry.touched).toEqual([])
    expect(telemetry.get('orphan')?.state).toBe('active')
  })
})
