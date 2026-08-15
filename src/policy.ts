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

/**
 * Pure decision, exported for tests: `undefined` means "not ours" or "gate
 * off" and delegates to the next pre-execute listener.
 */
export function decidePreExecute(
  exec: { readonly name: string; readonly arguments: unknown },
  approvalOn: boolean,
): PreToolDecision | undefined {
  if (exec.name !== TOOL_NAME || !approvalOn) return undefined
  return { kind: 'ask', reason: approvalReason(exec.arguments) }
}

/** Register the gate; the flag is read live so a settings commit toggles it. */
export function installApprovalPolicy(ctx: Context, configSource: ConfigSource): void {
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>) => {
    return decidePreExecute(exec, configSource.get().approval) ?? next()
  })
}
