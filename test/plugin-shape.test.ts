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
    })
    expect(resolved.memoryCharLimit).toBe(4000)
    expect(resolved.approval).toBe(true)
    expect(resolved.reviewModel).toBe('cheap')
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
      // The gateway Service registers itself through ctx.reflect.provide.
      reflect: { provide: vi.fn() },
    } as unknown as Context
    return { ctx, injected }
  }

  it('installs the command and background review inside inject scopes by default', () => {
    const { ctx, injected } = applyCtx()
    plugin.apply(ctx, {})
    expect(injected).toEqual([['commands'], ['llm']])
  })

  it('backgroundReview: false skips the review wiring', () => {
    const { ctx, injected } = applyCtx()
    plugin.apply(ctx, { backgroundReview: false })
    expect(injected).toEqual([['commands']])
  })

  it('approval: true disables the review even when enabled', () => {
    const { ctx, injected } = applyCtx()
    plugin.apply(ctx, { approval: true, backgroundReview: true })
    expect(injected).toEqual([['commands']])
  })
})
