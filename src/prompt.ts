/**
 * Frozen per-session memory snapshot injected as a system-prompt section.
 *
 * The systemPrompt text provider is re-evaluated on every step (each LLM
 * request), so freezing is implemented here: the first evaluation for an
 * agent reads the files synchronously and caches the rendered text in a
 * WeakMap keyed by the Agent object. A new session is a new Agent, so it
 * misses the cache and re-reads the files — exactly the Hermes semantics
 * (mid-session writes reach disk but only future sessions' prompts).
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AssembleContext, PromptSection } from '@deepseek-ai/dsh-system-prompt'
import { usageHeader } from './errors.js'
import { HIDDEN_ENTRY_PLACEHOLDER, scan } from './scan.js'
import type { FileSnapshot, MemoryFileKey } from './store.js'
import type { MemoryStore } from './store.js'

/**
 * dsh's renderPrompt strictly interpolates `{{name}}` groups anywhere in
 * section text and THROWS on unknown or malformed ones — an entry like
 * "Vue interpolation is {{ msg }}" would brick every future session at
 * assembly time, before the model is even called. Breaking up adjacent
 * braces makes a group syntactically impossible; a lone `{` never starts
 * one. This must not depend on the securityScan flag.
 */
function neutralizeBraces(text: string): string {
  return text.replace(/\{(?=\{)/g, '{ ')
}

export const SECTION_NAME = 'memory:snapshot'
/** Between deployment persona (0) and tool guidance (100-199). */
export const SECTION_ORDER = 50

const GUIDANCE = `## Persistent memory

You have two small persistent memory files, shown below as a snapshot frozen at
session start. Writes during this session persist to disk and appear in future
sessions; this snapshot does not update mid-session, but each memory tool result
shows the live state.

Manage them with the \`memory\` tool (add / replace / remove — no read action;
the content is already here). Entries are terse single lines. replace and remove
locate an entry by a unique substring.

Save: durable environment facts, conventions and decisions with lasting effect,
fixes for pitfalls you hit, explicit user preferences and constraints.
Skip: secrets and credentials, one-off task state, anything trivially
re-discoverable, speculation, bulk content (save a pointer to it instead).

Capacity is deliberately small. Above ~80% usage, consolidate before adding:
merge overlapping entries, remove stale ones. An overflow error lists the
current entries — consolidate and retry in the same turn without losing the
new fact.`

const FILE_TITLES: Readonly<Record<MemoryFileKey, string>> = {
  memory: 'MEMORY.md — agent notes',
  user: 'USER.md — user profile',
}

function renderFile(key: MemoryFileKey, snapshot: FileSnapshot, securityScan: boolean): string {
  const header = `### ${FILE_TITLES[key]} ${usageHeader(snapshot.chars, snapshot.limit)}`
  if (snapshot.readError !== undefined) {
    return `${header}\n\n(memory unavailable: ${neutralizeBraces(snapshot.readError)})`
  }
  if (snapshot.entries.length === 0) {
    return `${header}\n\n(empty — nothing saved yet)`
  }
  const lines = snapshot.entries.map((entry) => {
    // Side-door scan: hand-edited files must not smuggle content past the
    // write-path scan and into the system prompt.
    if (securityScan && scan(entry) !== undefined) {
      return `- ${HIDDEN_ENTRY_PLACEHOLDER}`
    }
    return `- ${neutralizeBraces(entry)}`
  })
  return `${header}\n\n${lines.join('\n')}`
}

export function renderSnapshot(
  snapshots: Readonly<Record<MemoryFileKey, FileSnapshot>>,
  securityScan: boolean,
): string {
  return [
    GUIDANCE,
    renderFile('memory', snapshots.memory, securityScan),
    renderFile('user', snapshots.user, securityScan),
  ].join('\n\n')
}

export function createSnapshotSection(store: MemoryStore, securityScan: boolean): PromptSection {
  const frozen = new WeakMap<Agent, string>()
  return {
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: (context: AssembleContext): string => {
      const agent = context.agent
      // Bare assembly (diagnostics, no session): contribute nothing.
      if (agent === undefined) return ''
      let snapshot = frozen.get(agent)
      if (snapshot === undefined) {
        snapshot = renderSnapshot(store.readAllSync(), securityScan)
        frozen.set(agent, snapshot)
      }
      return snapshot
    },
  }
}
