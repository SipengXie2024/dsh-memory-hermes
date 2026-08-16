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

Save: who the user is (persona, preferences, behavior expectations), durable
environment facts and project state, conventions with lasting effect.
Skip: secrets and credentials, one-off task state, anything trivially
re-discoverable, speculation, bulk content (write that to a topic file and keep
a one-line pointer here — see below).
Techniques and workflow lessons do not belong here — a background review
maintains those as skills in the skill library; reference them by name instead.

Capacity is deliberately small. Above ~80% usage, consolidate before adding:
merge overlapping entries, remove stale ones. An overflow error lists the
current entries — consolidate and retry in the same turn without losing the
new fact. Entries ending in \`→ topics/<name>.md\` are index pointers to detail
files — always keep the pointer when consolidating.`

/** Detail-layer paragraph; rendered with the resolved on-disk location. */
function topicGuidance(dir: string): string {
  return `### Topic files (the detail layer)

When a fact needs more room than one line — commands, examples, a debugging
narrative — write the detail to a topic file with the \`memory_topic\` tool
(topic_write / topic_append) and keep the index entry to one line ending in
\`→ topics/<name>.md\` (always this relative form in the index, never an
absolute path). Topic files are stored on disk at ${dir} and are NOT part of
this snapshot: read them on demand with topic_read (a bounded window; use
offset to continue). Every topic file must be referenced by at least one
index entry, or it is invisible to future sessions.`
}

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
  topicsDir?: string,
): string {
  return [
    GUIDANCE,
    ...topicsDir === undefined ? [] : [topicGuidance(topicsDir)],
    renderFile('memory', snapshots.memory, securityScan),
    renderFile('user', snapshots.user, securityScan),
  ].join('\n\n')
}

export function createSnapshotSection(
  store: MemoryStore,
  securityScan: () => boolean,
  topics?: () => { enabled: boolean; dir: string },
): PromptSection {
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
        // The flags are read at freeze time; a live settings change applies
        // to the NEXT session's snapshot, not this one's frozen text.
        const topicsState = topics?.()
        snapshot = renderSnapshot(
          store.readAllSync(),
          securityScan(),
          topicsState?.enabled === true ? topicsState.dir : undefined,
        )
        frozen.set(agent, snapshot)
      }
      return snapshot
    },
  }
}
