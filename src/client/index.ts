/**
 * Client half of dsh-memory-hermes: registers the memory panel as a settings
 * page (the settings.section list slot) and bridges it to the host gateway
 * over the shared /api RPC channel. Value imports stay inside the loader
 * module table (react only); every dsh type arrives type-only.
 */

import type { Context } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PanelListResult, PanelMutateOutcome, PanelReviewRunsResult, PanelSkillsResult } from '../gateway.js'
import type { MemoryToolArgs } from '../tool.js'
import { LIST_CALL, LIST_REVIEW_RUNS_CALL, LIST_SKILLS_CALL, mutateCall, unwrapRpc } from './logic.js'
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
    listReviewRuns: async () =>
      unwrapRpc<PanelReviewRunsResult>(
        await connection.rpc.call(LIST_REVIEW_RUNS_CALL.channel, LIST_REVIEW_RUNS_CALL.endpoint, LIST_REVIEW_RUNS_CALL.payload),
      ),
    listSkills: async () =>
      unwrapRpc<PanelSkillsResult>(
        await connection.rpc.call(LIST_SKILLS_CALL.channel, LIST_SKILLS_CALL.endpoint, LIST_SKILLS_CALL.payload),
      ),
  }
  // One settings page per list entry. The owner hands sections only
  // { close }, which this panel never uses — the thunk closes over the face
  // instead of taking owner props. No sidebar affordance: the settings nav
  // row the shell renders for this entry IS the entry point.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'memory',
    order: 30,
    label: '记忆',
  }, () => createElement(MemoryPanel, face)))
}
