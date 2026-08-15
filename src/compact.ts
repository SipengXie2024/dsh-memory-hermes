/**
 * /memory compact: human-reviewed consolidation of the two bounded files.
 * One auxiliary LLM call proposes merged entry lists; the proposal is shown
 * to the user through the dsh approval service and only an explicit allow
 * rewrites the files (store.rewrite, same locked/atomic path as mutate).
 * This is the proactive sibling of the overflow error's same-turn
 * consolidation recovery — cheaper than waiting for the file to fill.
 *
 * @module dsh-memory-hermes/compact
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { serializeEntries } from './entries.js'
import { usageHeader } from './errors.js'
import { scan } from './scan.js'
import type { ConfigSource } from './settings.js'
import type { MemoryStore } from './store.js'

/** Structural view of the optional dsh approval seam (`ctx.get('approval')`). */
export interface ApprovalLike {
  request(request: {
    agent: Agent
    toolName: string
    reason?: string
    signal?: AbortSignal
  }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
}

export interface Consolidation {
  readonly memory: readonly string[]
  readonly user: readonly string[]
}

/** Consolidation protocol: two markdown sections of single-line bullets. */
export const CONSOLIDATE_INSTRUCTION = 'You are consolidating two small persistent memory files '
  + '(MEMORY.md: agent notes; USER.md: user profile). Merge overlapping entries, drop stale or '
  + 're-discoverable ones, and keep every durable fact, preference, convention, and pitfall fix. '
  + 'Entries are single terse lines. Reply with EXACTLY two markdown sections and nothing else: '
  + 'a "## MEMORY.md" heading followed by "- entry" lines, then a "## USER.md" heading followed '
  + 'by "- entry" lines. Keep a section present even when it ends up empty.'

/**
 * Parse a consolidation reply. Fail-loud on protocol violations — a
 * malformed reply must never produce a partial rewrite.
 */
export function parseConsolidation(text: string): Consolidation {
  const sections: { memory: string[]; user: string[] } = { memory: [], user: [] }
  let current: 'memory' | 'user' | undefined
  const seen = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const heading = /^##\s+(MEMORY\.md|USER\.md)\s*$/.exec(line.trim())
    if (heading !== null) {
      current = heading[1] === 'USER.md' ? 'user' : 'memory'
      if (seen.has(current)) throw new Error(`duplicate ${heading[1]} section`)
      seen.add(current)
      continue
    }
    if (current === undefined) continue // preamble before the first heading
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (!trimmed.startsWith('- ')) {
      throw new Error(`non-entry line inside the ${current === 'user' ? 'USER.md' : 'MEMORY.md'} section: "${[...trimmed].slice(0, 60).join('')}"`)
    }
    sections[current].push(trimmed.slice(2).trim())
  }
  if (!seen.has('memory') || !seen.has('user')) {
    throw new Error('the reply must contain both ## MEMORY.md and ## USER.md sections')
  }
  return sections
}

export interface CompactDeps {
  readonly store: MemoryStore
  readonly configSource: ConfigSource
  readonly getApproval: () => ApprovalLike | undefined
}

interface SessionsLike {
  get(id: unknown): Session | undefined
}

interface LlmLike {
  stream(options: Record<string, unknown>): AsyncIterable<unknown>
}

/**
 * Run one human-reviewed compaction for the agent's session. Returns the
 * report text the /memory compact command replies with; never throws for
 * business failures (they are reported, nothing is written).
 */
export async function runCompact(
  ctx: Context,
  deps: CompactDeps,
  agent: Agent,
  signal?: AbortSignal,
): Promise<string> {
  const sessions = ctx.get('sessions') as SessionsLike | undefined
  const session = sessions?.get(agent.id)
  const header = session?.requestHeader()
  if (session === undefined || header === undefined) {
    return 'Cannot compact: this session has not routed a model request yet.'
  }
  const llm = ctx.get('llm') as LlmLike | undefined
  if (llm === undefined) return 'Cannot compact: no llm service is composed in this profile.'
  const config = deps.configSource.get()
  const before = deps.store.readAllSync()

  const messages: Message[] = [createUserMessage({
    content: [{
      type: 'text',
      text: `${CONSOLIDATE_INSTRUCTION}\n\nCurrent MEMORY.md entries:\n${serializeEntries([...before.memory.entries])}\n`
        + `Current USER.md entries:\n${serializeEntries([...before.user.entries])}`,
    }],
    source: { kind: 'plugin', plugin: 'dsh-memory-hermes' },
  })]
  const assembler = new BlockAssembler()
  for await (const chunk of llm.stream({
    provider: config.reviewProvider ?? header.config.provider,
    model: config.reviewModel ?? header.config.model,
    messages,
    ...header.system === undefined ? {} : { system: header.system },
    maxTokens: config.consolidateMaxTokens,
    sessionId: session.id,
    signal,
  })) {
    assembler.push(chunk as never)
  }
  const finish = assembler.finish
  if (finish.kind === 'aborted' || finish.kind === 'error') {
    return `Compaction failed: the consolidation call did not finish cleanly (${finish.kind}). Nothing was written.`
  }
  const text = assembler.blocks()
    .filter(block => block.type === 'text')
    .map(block => (block as { type: 'text'; text: string }).text)
    .join('\n')

  let consolidation: Consolidation
  try {
    consolidation = parseConsolidation(text)
  } catch (error) {
    return `Compaction failed: ${error instanceof Error ? error.message : String(error)}. Nothing was written.`
  }
  if (config.securityScan) {
    for (const entry of [...consolidation.memory, ...consolidation.user]) {
      const hit = scan(entry)
      if (hit !== undefined) {
        return `Compaction rejected by the security scan (${hit.ruleId}) on entry "${[...entry].slice(0, 60).join('')}". Nothing was written.`
      }
    }
  }

  const reason = `memory compact: MEMORY.md ${before.memory.entries.length} -> ${consolidation.memory.length} entries, `
    + `USER.md ${before.user.entries.length} -> ${consolidation.user.length} entries`
  const proposal = ['## MEMORY.md', serializeEntries([...consolidation.memory]).trimEnd(), '', '## USER.md', serializeEntries([...consolidation.user]).trimEnd()].join('\n')
  const approval = deps.getApproval()
  if (approval === undefined) {
    return `Proposed consolidation (NOT applied — no approval channel is available):\n${reason}\n\n${proposal}`
  }
  let outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
  try {
    outcome = await approval.request({ agent, toolName: 'memory', reason, ...signal === undefined ? {} : { signal } })
  } catch {
    outcome = 'unavailable'
  }
  if (outcome !== 'allowed-once') {
    return `Compaction ${outcome === 'rejected' ? 'declined' : outcome}; nothing was written.\n\n${proposal}`
  }
  try {
    const memoryResult = await deps.store.rewrite('memory', consolidation.memory)
    const userResult = await deps.store.rewrite('user', consolidation.user)
    return [
      'Compacted.',
      `MEMORY.md: ${before.memory.entries.length} -> ${memoryResult.entries} entries, now ${usageHeader(memoryResult.chars, memoryResult.limit)} (was ${usageHeader(before.memory.chars, before.memory.limit)}).`,
      `USER.md: ${before.user.entries.length} -> ${userResult.entries} entries, now ${usageHeader(userResult.chars, userResult.limit)} (was ${usageHeader(before.user.chars, before.user.limit)}).`,
    ].join('\n')
  } catch (error) {
    return `Compaction failed at write time: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`
  }
}
