/**
 * Client half of dsh-memory-hermes: registers the memory panel into the
 * sidebar footer-action slot and bridges it to the host gateway over the
 * shared /api RPC channel. Value imports stay inside the loader module
 * table (react via jsx-runtime only); every dsh type arrives type-only.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PanelListResult, PanelMutateOutcome } from '../gateway.js'
import type { MemoryToolArgs } from '../tool.js'
import { LIST_CALL, mutateCall, unwrapRpc } from './logic.js'
import { MemoryPanel } from './MemoryPanel.js'
import type { MemoryPanelFace } from './MemoryPanel.js'

export const name = 'memory-hermes-panel'
export const inject = ['slots', 'connection']

export function apply(ctx: Context): void {
  // The client-connection package provides ctx.connection without a typed
  // Context augmentation on the client face; read it structurally.
  const connection = ctx.get('connection') as ConnectionHandle | undefined
  if (connection === undefined) return
  const face: MemoryPanelFace = {
    listMemory: async () =>
      unwrapRpc<PanelListResult>(await connection.rpc.call(LIST_CALL.channel, LIST_CALL.endpoint, LIST_CALL.payload)),
    mutateMemory: async (op: MemoryToolArgs) => {
      const call = mutateCall(op)
      return unwrapRpc<PanelMutateOutcome>(await connection.rpc.call(call.channel, call.endpoint, call.payload))
    },
  }
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'memory-hermes',
    inject: () => face,
  }, MemoryPanel))
}
