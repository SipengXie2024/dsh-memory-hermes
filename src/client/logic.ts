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
