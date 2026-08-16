/**
 * The approval gate as a `tools/pre-execute` policy listener — dsh's
 * designed allow/deny/ask seam — instead of logic hardcoded inside the
 * tool body. The tool itself stays policy-free; the tools runtime turns
 * `ask` into an approval-service request and denies fail-closed when no
 * approval channel exists. The background review never passes this
 * pipeline (it writes through the store directly), which is exactly why
 * the review stays disabled while the approval gate is on: a background
 * write cannot ask.
 *
 * @module dsh-memory-hermes/policy
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ConfigSource } from './settings.js'
import { TOOL_NAME, validateMemoryArgs, writtenText } from './tool.js'
import type { MemoryToolArgs } from './tool.js'
import { READ_ONLY_ACTIONS, TOPIC_TOOL_NAME } from './topics.js'
import type { TopicToolArgs } from './topics.js'

function truncate(text: string, max: number): string {
  return [...text].length <= max ? text : `${[...text].slice(0, max).join('')}...`
}

/** Human-facing reason for one gated write; best-effort over raw arguments. */
export function approvalReason(args: unknown): string {
  try {
    const call = validateMemoryArgs(args as MemoryToolArgs)
    const subject = writtenText(call.op) ?? (call.op.action === 'remove' ? call.op.target : '')
    return `memory ${call.op.action} in ${call.file === 'user' ? 'USER.md' : 'MEMORY.md'}: "${truncate(subject, 120)}"`
  } catch {
    return 'memory write'
  }
}

/** Human-facing reason for one gated topic write. */
export function topicApprovalReason(args: unknown): string {
  const raw = (args ?? {}) as TopicToolArgs
  const name = typeof raw.name === 'string' && raw.name !== '' ? raw.name : '?'
  const detail = typeof raw.content === 'string' && raw.content !== '' ? `: "${truncate(raw.content, 120)}"` : ''
  return `memory_topic ${String(raw.action ?? 'write')} topics/${name}.md${detail}`
}

/**
 * Pure decision, exported for tests: `undefined` means "not ours" or "gate
 * off" and delegates to the next pre-execute listener. Topic reads use a
 * whitelist (topic_list / topic_read pass); every other topic action asks,
 * so a future mutating action is gated by default. When topics are disabled
 * the execute path refuses with an explanation — asking first would waste a
 * click on a write that cannot land.
 */
export function decidePreExecute(
  exec: { readonly name: string; readonly arguments: unknown },
  approvalOn: boolean,
  topicsEnabled = true,
): PreToolDecision | undefined {
  if (!approvalOn) return undefined
  if (exec.name === TOOL_NAME) return { kind: 'ask', reason: approvalReason(exec.arguments) }
  if (exec.name === TOPIC_TOOL_NAME) {
    if (!topicsEnabled) return undefined
    const action = (exec.arguments as { action?: string } | undefined)?.action
    if (action !== undefined && READ_ONLY_ACTIONS.includes(action)) return undefined
    return { kind: 'ask', reason: topicApprovalReason(exec.arguments) }
  }
  return undefined
}

/** Register the gate; the flags are read live so a settings commit toggles it. */
export function installApprovalPolicy(ctx: Context, configSource: ConfigSource): void {
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>) => {
    const config = configSource.get()
    return decidePreExecute(exec, config.approval, config.topicsEnabled) ?? next()
  })
}
