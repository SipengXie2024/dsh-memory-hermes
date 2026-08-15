/**
 * The /memory slash command: a read-only window into the two memory files
 * for headless and terminal surfaces (the web panel is the richer sibling).
 * Registered through an inject scope so profiles without the commands
 * plugin skip it silently instead of failing to load.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import { usageHeader } from './errors.js'
import type { FileSnapshot, MemoryFileKey, MemoryStore } from './store.js'

const ORDER: readonly MemoryFileKey[] = ['memory', 'user']

/** Render both files as the command's plain-text reply. */
export function renderMemoryReport(snapshots: Readonly<Record<MemoryFileKey, FileSnapshot>>): string {
  const sections = ORDER.map((key) => {
    const snap = snapshots[key]
    const count = `${snap.entries.length} ${snap.entries.length === 1 ? 'entry' : 'entries'}`
    const head = `${snap.label} ${usageHeader(snap.chars, snap.limit)}, ${count}`
    if (snap.readError !== undefined) return `${head}\n  (read error: ${snap.readError})`
    if (snap.entries.length === 0) return `${head}\n  (empty)`
    return `${head}\n${snap.entries.map(entry => `  - ${entry}`).join('\n')}`
  })
  return sections.join('\n\n')
}

/** Register /memory when the commands service is available. */
export function installMemoryCommand(ctx: Context, store: MemoryStore): void {
  ctx.inject(['commands'], (scoped) => {
    scoped.commands.register({
      name: 'memory',
      description: 'Show the persistent memory files (MEMORY.md / USER.md) and their usage',
      handler: () => ({
        kind: 'success',
        text: renderMemoryReport(store.readAllSync()),
      }),
    })
  })
}
