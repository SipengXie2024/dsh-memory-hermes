import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.js'

describe('plugin shape', () => {
  it('exports the cordis plugin surface', () => {
    expect(plugin.name).toBe('memory-hermes')
    expect(plugin.inject).toEqual(['tools', 'systemPrompt'])
    expect(typeof plugin.apply).toBe('function')
    expect(typeof plugin.Config).toBe('function')
  })

  it('Config fills Hermes defaults', () => {
    const resolved = new plugin.Config({})
    expect(resolved).toEqual({
      memoryCharLimit: 2200,
      userCharLimit: 1375,
      securityScan: true,
      approval: false,
      backgroundReview: true,
      reviewMaxTokens: 1000,
      reviewTimeoutMs: 60_000,
      reviewTrigger: 'token-delta',
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
    })
  })

  it('Config rejects sub-minimum limits', () => {
    expect(() => new plugin.Config({ memoryCharLimit: 10 })).toThrow()
  })

  it('Config accepts a full override', () => {
    const resolved = new plugin.Config({
      memoryCharLimit: 4000,
      userCharLimit: 2000,
      securityScan: false,
      approval: true,
      backgroundReview: false,
      reviewProvider: 'other',
      reviewModel: 'cheap',
      reviewMaxTokens: 500,
      reviewTimeoutMs: 5000,
      reviewTrigger: 'every-turn',
      reviewTokenDeltaTokens: 8000,
      compactionHarvest: false,
      reviewHistoryLimit: 50,
      consolidateMaxTokens: 3000,
    })
    expect(resolved.memoryCharLimit).toBe(4000)
    expect(resolved.approval).toBe(true)
    expect(resolved.reviewModel).toBe('cheap')
    expect(resolved.reviewTrigger).toBe('every-turn')
    expect(resolved.compactionHarvest).toBe(false)
  })
})

describe('apply wiring', () => {
  /** Fake ctx recording inject() scopes; the scoped callback is never run. */
  const applyCtx = () => {
    const injected: string[][] = []
    const ctx = {
      systemPrompt: { section: vi.fn() },
      tools: { register: vi.fn() },
      get: () => undefined,
      inject: (deps: string[]) => { injected.push(deps) },
      on: vi.fn(),
      logger: { warn: vi.fn(), info: vi.fn() },
      // The gateway Service registers itself through ctx.reflect.provide.
      reflect: { provide: vi.fn() },
    } as unknown as Context
    return { ctx, injected }
  }

  it('wires every optional capability through inject scopes', () => {
    const { ctx, injected } = applyCtx()
    plugin.apply(ctx, {})
    expect(injected).toEqual([['settings'], ['storageDomain'], ['llm'], ['sessionProjections'], ['commands']])
  })

  it('review wiring is unconditional — policy flags are read at fire time', () => {
    const { ctx, injected } = applyCtx()
    plugin.apply(ctx, { backgroundReview: false })
    expect(injected).toEqual([['settings'], ['storageDomain'], ['llm'], ['sessionProjections'], ['commands']])
  })

  it('approval: true keeps the same wiring (the gate is a pre-execute listener)', () => {
    const { ctx, injected } = applyCtx()
    plugin.apply(ctx, { approval: true, backgroundReview: true })
    expect(injected).toEqual([['settings'], ['storageDomain'], ['llm'], ['sessionProjections'], ['commands']])
  })

  it('installs the approval gate as a tools/pre-execute listener', () => {
    const { ctx } = applyCtx()
    plugin.apply(ctx, {})
    expect(vi.mocked(ctx.on).mock.calls.map(call => call[0])).toContain('tools/pre-execute')
  })
})
