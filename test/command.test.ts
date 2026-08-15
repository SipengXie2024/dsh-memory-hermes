import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { installMemoryCommand, renderMemoryReport } from '../src/command.js'
import type { FileSnapshot, MemoryFileKey } from '../src/store.js'
import { MemoryStore } from '../src/store.js'

const snapshots = (over: Partial<Record<MemoryFileKey, Partial<FileSnapshot>>> = {}): Record<MemoryFileKey, FileSnapshot> => ({
  memory: { label: 'MEMORY.md', limit: 200, entries: ['uses pnpm', 'prefers tabs'], chars: 27, ...over.memory },
  user: { label: 'USER.md', limit: 100, entries: [], chars: 0, ...over.user },
})

describe('renderMemoryReport', () => {
  it('renders usage headers, entry lists, and an empty marker', () => {
    expect(renderMemoryReport(snapshots())).toBe(
      'MEMORY.md [14% — 27/200 chars], 2 entries\n'
      + '  - uses pnpm\n'
      + '  - prefers tabs\n'
      + '\n'
      + 'USER.md [0% — 0/100 chars], 0 entries\n'
      + '  (empty)',
    )
  })

  it('uses the singular form for one entry', () => {
    const text = renderMemoryReport(snapshots({ memory: { entries: ['only one'], chars: 11 } }))
    expect(text).toContain('1 entry\n')
  })

  it('surfaces read errors instead of entries', () => {
    const text = renderMemoryReport(snapshots({ user: { readError: 'EACCES: denied' } }))
    expect(text).toContain('USER.md')
    expect(text).toContain('(read error: EACCES: denied)')
  })
})

describe('installMemoryCommand', () => {
  let dir: string
  let store: MemoryStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-memory-cmd-'))
    store = new MemoryStore({
      files: {
        memory: { path: join(dir, 'MEMORY.md'), label: 'MEMORY.md', limit: 200 },
        user: { path: join(dir, 'USER.md'), label: 'USER.md', limit: 100 },
      },
      securityScan: true,
    })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** Fake ctx that runs inject callbacks immediately and records registrations. */
  const commandCtx = () => {
    const registered: Record<string, any>[] = []
    const scoped = { commands: { register: (definition: Record<string, any>) => { registered.push(definition) } } }
    const ctx = {
      inject: (_deps: string[], callback: (scoped: unknown) => void) => { callback(scoped) },
    } as unknown as Context
    return { ctx, registered }
  }

  it('registers /memory with a live-state handler', async () => {
    await store.mutate('memory', { action: 'add', content: 'learned in session' })
    const { ctx, registered } = commandCtx()
    installMemoryCommand(ctx, store)
    expect(registered).toHaveLength(1)
    expect(registered[0].name).toBe('memory')
    expect(typeof registered[0].description).toBe('string')
    const result = await registered[0].handler({})
    expect(result.kind).toBe('success')
    expect(result.text).toContain('- learned in session')
    expect(result.text).toContain('USER.md')
  })
})
