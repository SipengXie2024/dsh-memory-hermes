/**
 * Memory-activity projection unit: this session's memory tool calls folded
 * out of its own committed log (tool/call pairs with tool/result by callId).
 * Being a log fold, the value survives resume and rides the persisted
 * projection cache — memory activity becomes a log derivative, in line with
 * dsh's "the session log is the truth" posture. State is a handful of
 * scalars plus the in-flight call map, so checkpoints stay O(in-flight).
 *
 * @module dsh-memory-hermes/projection
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

/** Wire value: whole current memory-activity summary of one session. */
export interface MemoryActivityProjection {
  readonly calls: number
  readonly succeeded: number
  readonly failed: number
  readonly lastAction?: 'add' | 'replace' | 'remove' | undefined
  readonly lastFile?: 'memory' | 'user' | undefined
  readonly lastAt?: number | undefined
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    memoryActivity: MemoryActivityProjection
  }
}

interface PendingCall {
  readonly action?: 'add' | 'replace' | 'remove' | undefined
  readonly file?: 'memory' | 'user' | undefined
  readonly at: number
}

interface MemoryActivityState {
  readonly calls: number
  readonly succeeded: number
  readonly failed: number
  readonly lastAction?: 'add' | 'replace' | 'remove' | undefined
  readonly lastFile?: 'memory' | 'user' | undefined
  readonly lastAt?: number | undefined
  readonly pending: Readonly<Record<string, PendingCall>>
}

export const memoryActivitySchema = z.object({
  calls: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  lastAction: z.enum(['add', 'replace', 'remove']).optional(),
  lastFile: z.enum(['memory', 'user']).optional(),
  lastAt: z.number().optional(),
})

const INITIAL: MemoryActivityState = { calls: 0, succeeded: 0, failed: 0, pending: {} }

export const memoryActivityProjection: ProjectionDefinition<'memoryActivity', MemoryActivityState> = {
  key: 'memoryActivity',
  schema: memoryActivitySchema,
  stateVersion: 1,
  init: () => INITIAL,
  apply(state, event: SessionEvent) {
    if (event.type === 'tool/call' && event.data.name === 'memory') {
      let action: PendingCall['action']
      let file: PendingCall['file']
      try {
        const args = JSON.parse(event.data.arguments) as { action?: unknown; file?: unknown }
        if (args.action === 'add' || args.action === 'replace' || args.action === 'remove') action = args.action
        if (args.file === 'memory' || args.file === 'user') file = args.file
      } catch {
        // Unparseable arguments still count as a call attempt.
      }
      return {
        ...state,
        calls: state.calls + 1,
        pending: { ...state.pending, [String(event.data.callId)]: { action, file, at: event.time } },
      }
    }
    if (event.type === 'tool/result') {
      const block = event.data.message.content[0] as { callId?: unknown } | undefined
      const callId = typeof block?.callId === 'string' ? block.callId : undefined
      const pending = callId === undefined ? undefined : state.pending[callId]
      if (callId === undefined || pending === undefined) return state
      const rest = { ...state.pending }
      delete rest[callId]
      const failed = event.data.error !== undefined
      return {
        ...state,
        succeeded: state.succeeded + (failed ? 0 : 1),
        failed: state.failed + (failed ? 1 : 0),
        ...pending.action === undefined ? {} : { lastAction: pending.action },
        ...pending.file === undefined ? {} : { lastFile: pending.file },
        lastAt: pending.at,
        pending: rest,
      }
    }
    return state
  },
  view(state) {
    return {
      calls: state.calls,
      succeeded: state.succeeded,
      failed: state.failed,
      ...state.lastAction === undefined ? {} : { lastAction: state.lastAction },
      ...state.lastFile === undefined ? {} : { lastFile: state.lastFile },
      ...state.lastAt === undefined ? {} : { lastAt: state.lastAt },
    }
  },
}

/** Register the unit when the host composes the projection registry. */
export function installProjection(ctx: Context): void {
  ctx.inject(['sessionProjections'], (scoped) => {
    const registry = scoped.get('sessionProjections') as {
      register(definition: ProjectionDefinition<'memoryActivity', MemoryActivityState>): () => void
    } | undefined
    registry?.register(memoryActivityProjection)
  })
}
