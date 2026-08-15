/**
 * Pure client-side logic for the memory panel: RPC call shapes, result
 * unwrapping, and display formatting. No imports at all, so the node-side
 * test runner exercises exactly what the browser bundle inlines.
 *
 * The RPC endpoint grammar and payload shape mirror dsh's Typert gateway:
 * endpoint `<namespace>/<method>` on the shared '/api' channel, payload
 * `{ args: { <parameterName>: value } }` with keys matched against the host
 * method's parameter names (SRC reflection).
 */

import type { MemoryToolArgs } from '../tool.js'

export const RPC_CHANNEL = '/api'

/** Call shape for MemoryHermesGateway.list (no parameters -> empty args). */
export const LIST_CALL = {
  channel: RPC_CHANNEL,
  endpoint: 'memoryHermes/list',
  payload: { args: {} },
} as const

/** Call shape for MemoryHermesGateway.listReviewRuns (no parameters). */
export const LIST_REVIEW_RUNS_CALL = {
  channel: RPC_CHANNEL,
  endpoint: 'memoryHermes/listReviewRuns',
  payload: { args: {} },
} as const

/** Call shape for MemoryHermesGateway.listSkills (no parameters). */
export const LIST_SKILLS_CALL = {
  channel: RPC_CHANNEL,
  endpoint: 'memoryHermes/listSkills',
  payload: { args: {} },
} as const

/** Call shape for MemoryHermesGateway.mutate(op). */
export function mutateCall(op: MemoryToolArgs): {
  channel: string
  endpoint: string
  payload: { args: { op: MemoryToolArgs } }
} {
  return {
    channel: RPC_CHANNEL,
    endpoint: 'memoryHermes/mutate',
    payload: { args: { op } },
  }
}

/** Structural mirror of dsh's RpcResult; local so no value import is needed. */
export type RpcOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly message: string; readonly code?: string } }

/** Narrow an unknown RPC result and return its value, or throw its error message. */
export function unwrapRpc<T>(outcome: unknown): T {
  if (typeof outcome !== 'object' || outcome === null || typeof (outcome as { ok?: unknown }).ok !== 'boolean') {
    throw new Error('malformed RPC result')
  }
  const result = outcome as RpcOutcome
  if (result.ok) return result.value as T
  const message = result.error?.message
  throw new Error(typeof message === 'string' && message !== '' ? message : 'RPC call failed')
}

/** Usage line under a file heading, e.g. `41% full — 91/220 chars`. */
export function formatUsage(chars: number, limit: number, percent: number): string {
  return `${percent}% full ${String.fromCodePoint(0x2014)} ${chars}/${limit} chars`
}

/** Human duration: `800ms` / `46秒` / `2分25秒` / `1小时3分`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms))
  if (total < 1000) return `${total}ms`
  const seconds = Math.floor(total / 1000)
  if (seconds < 60) return `${seconds}秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    const rest = seconds % 60
    return rest === 0 ? `${minutes}分` : `${minutes}分${rest}秒`
  }
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes === 0 ? `${hours}小时` : `${hours}小时${restMinutes}分`
}

/**
 * Clean one error line for display. Review errors arrive as
 * `...: {"message":"400 {\"error\":{\"message\":\"tool_call_id is not found\"}}","code":"..."}` —
 * unwrap the nested JSON shells down to the innermost message.
 */
export function cleanErrorMessage(error: string): string {
  let text = error.replace(/^review call did not finish cleanly \((error|aborted)\):?\s*/, '')
  for (let depth = 0; depth < 4; depth += 1) {
    const brace = text.indexOf('{')
    if (brace === -1) break
    let parsed: unknown
    try {
      parsed = JSON.parse(text.slice(brace))
    } catch {
      break
    }
    if (typeof parsed !== 'object' || parsed === null) break
    const record = parsed as Record<string, unknown>
    const next = typeof record.error === 'object' && record.error !== null
      ? (record.error as Record<string, unknown>).message
      : record.message
    if (typeof next !== 'string' || next === '') break
    // "400 {...}" prefixes: keep unwrapping when the payload starts with JSON.
    text = next.replace(/^\d{3}\s+/, '')
    if (!text.startsWith('{')) {
      text = next
      break
    }
  }
  const firstLine = text.split('\n')[0]!.trim()
  return [...firstLine].length <= 140 ? firstLine : `${[...firstLine].slice(0, 140).join('')}...`
}

/** Structural mirror of the review-run row the panel renders. */
export interface RunSummaryInput {
  readonly applied: number
  readonly rejected: number
  readonly malformed: number
  readonly foreign: number
  readonly steps?: number | undefined
  readonly skillActions?: {
    readonly created: number
    readonly updated: number
    readonly patched: number
    readonly deleted: number
    readonly filesWritten: number
    readonly filesRemoved: number
    readonly skills: readonly string[]
  } | undefined
}

/** One plain-Chinese summary sentence for a review run. */
export function summarizeRun(run: RunSummaryInput): string {
  const parts: string[] = []
  if (run.applied > 0) parts.push(`存了 ${run.applied} 条记忆`)
  if (run.rejected > 0) parts.push(`${run.rejected} 条被拒`)
  if (run.malformed > 0) parts.push(`${run.malformed} 条参数畸形`)
  if (run.foreign > 0) parts.push(`${run.foreign} 次越界调用`)
  const skill = run.skillActions
  if (skill !== undefined) {
    const bits: string[] = []
    if (skill.created > 0) bits.push(`新建 ${skill.created}`)
    if (skill.updated > 0) bits.push(`更新 ${skill.updated}`)
    if (skill.patched > 0) bits.push(`补丁 ${skill.patched}`)
    if (skill.deleted > 0) bits.push(`删除 ${skill.deleted}`)
    if (skill.filesWritten > 0) bits.push(`支持文件 ${skill.filesWritten}`)
    if (skill.filesRemoved > 0) bits.push(`移除文件 ${skill.filesRemoved}`)
    if (bits.length > 0) {
      parts.push(`skill:${bits.join('/')}${skill.skills.length > 0 ? `(${skill.skills.join(', ')})` : ''}`)
    }
  }
  return parts.length === 0 ? '没有新内容可存' : parts.join(' · ')
}
