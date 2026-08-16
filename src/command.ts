/**
 * The /memory slash command: a read-only window into the two memory files,
 * plus the two operator actions — `/memory review` (fire a background
 * review now) and `/memory compact` (human-reviewed consolidation). The web
 * panel is the richer sibling for browsing. Registered through an inject
 * scope so profiles without the commands plugin skip it silently instead of
 * failing to load.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import { usageHeader } from './errors.js'
import type { FileSnapshot, MemoryFileKey } from './store.js'
import type { MemoryStore } from './store.js'
import { formatKib, isReferenced } from './topics.js'

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

/** Operator actions the command delegates to the review/compact machinery. */
export interface MemoryCommandExtras {
  readonly triggerReview?: (agent: Agent, focus?: string) => void
  readonly runCompact?: (agent: Agent, signal: AbortSignal) => Promise<string>
  readonly listSkills?: () => Promise<readonly string[]>
  /** `/memory curator` — run the library-maintenance pass now. */
  readonly curatorRun?: () => Promise<string>
  /** `/memory curator status` — scheduling and library shape. */
  readonly curatorStatus?: () => Promise<string>
  /** `/memory pin|unpin <name>` — flip the curation exemption. */
  readonly pinSkill?: (name: string, pinned: boolean) => Promise<string>
  /** `/memory adopt <name>` — transfer a user-owned skill to the curator. */
  readonly adoptSkill?: (name: string) => Promise<string>
}

const USAGE = 'Usage: /memory — show the memory files; /memory review [focus] — run a background '
  + 'review now; /memory compact — propose a human-reviewed consolidation; /memory skills — list the skill library; '
  + '/memory topics — list topic files (the detail layer) with orphan markers; '
  + '/memory curator [status] — run the library-maintenance pass now / show its schedule; '
  + '/memory pin <name>, /memory unpin <name> — exempt a skill from automatic curation; '
  + '/memory adopt <name> — put a user-owned skill under curator management.'

const NOT_WIRED = 'The curator is not wired in this profile.'

/** Register /memory when the commands service is available. */
export function installMemoryCommand(ctx: Context, store: MemoryStore, extras: MemoryCommandExtras = {}): void {
  ctx.inject(['commands'], (scoped) => {
    scoped.commands.register({
      name: 'memory',
      description: 'Show the persistent memory files; review/compact/skills/topics/curator/pin/adopt for upkeep',
      // Without an input declaration the web composer only claims bare
      // `/memory`; argued lines (e.g. `/memory curator`) fall through to the
      // model as plain chat text (ui-commands matchEnter decision table).
      input: { hint: '[review [focus] | compact | skills | topics | curator [status] | pin|unpin|adopt <name>]' },
      handler: async (invocation) => {
        const input = (invocation.rawInput ?? '').trim()
        if (input === '') {
          return { kind: 'success' as const, text: renderMemoryReport(store.readAllSync()) }
        }
        if (input === 'review' || input.startsWith('review ')) {
          if (extras.triggerReview === undefined) {
            return { kind: 'success' as const, text: 'Background review is not wired in this profile.' }
          }
          const focus = input === 'review' ? undefined : input.slice('review '.length).trim()
          extras.triggerReview(invocation.agent, focus === '' ? undefined : focus)
          return { kind: 'success' as const, text: 'Background review triggered; the memory settings page activity log will show the outcome.' }
        }
        if (input === 'compact') {
          if (extras.runCompact === undefined) {
            return { kind: 'success' as const, text: 'Compaction is not wired in this profile.' }
          }
          return { kind: 'success' as const, text: await extras.runCompact(invocation.agent, invocation.signal) }
        }
        if (input === 'skills') {
          if (extras.listSkills === undefined) {
            return { kind: 'success' as const, text: 'The skill library is not wired in this profile.' }
          }
          const lines = await extras.listSkills()
          return { kind: 'success' as const, text: lines.length === 0 ? '(skill library is empty)' : lines.join('\n') }
        }
        if (input === 'topics') {
          if (!store.hasTopics()) {
            return { kind: 'success' as const, text: 'The topic layer is not wired in this profile.' }
          }
          const topics = await store.listTopics()
          if (topics.length === 0) return { kind: 'success' as const, text: '(no topic files yet)' }
          const snapshots = store.readAllSync()
          const indexText = [...snapshots.memory.entries, ...snapshots.user.entries].join('\n')
          const lines = topics.map(topic =>
            `- ${topic.name} (${formatKib(topic.bytes)})${isReferenced(topic.name, indexText) ? '' : ' [orphan — no index entry references it]'}`)
          return { kind: 'success' as const, text: lines.join('\n') }
        }
        if (input === 'curator status') {
          if (extras.curatorStatus === undefined) return { kind: 'success' as const, text: NOT_WIRED }
          return { kind: 'success' as const, text: await extras.curatorStatus() }
        }
        if (input === 'curator') {
          if (extras.curatorRun === undefined) return { kind: 'success' as const, text: NOT_WIRED }
          return { kind: 'success' as const, text: await extras.curatorRun() }
        }
        if (input.startsWith('pin ') || input.startsWith('unpin ')) {
          if (extras.pinSkill === undefined) return { kind: 'success' as const, text: NOT_WIRED }
          const pinned = input.startsWith('pin ')
          const skillName = input.slice(pinned ? 'pin '.length : 'unpin '.length).trim()
          if (skillName === '') return { kind: 'success' as const, text: USAGE }
          return { kind: 'success' as const, text: await extras.pinSkill(skillName, pinned) }
        }
        if (input.startsWith('adopt ')) {
          if (extras.adoptSkill === undefined) return { kind: 'success' as const, text: NOT_WIRED }
          const skillName = input.slice('adopt '.length).trim()
          if (skillName === '') return { kind: 'success' as const, text: USAGE }
          return { kind: 'success' as const, text: await extras.adoptSkill(skillName) }
        }
        return { kind: 'success' as const, text: USAGE }
      },
    })
  })
}
