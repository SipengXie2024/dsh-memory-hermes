/**
 * Hermes-style bounded curated memory for DeepSeek Harness, as an
 * out-of-tree user plugin: two small persistent files (MEMORY.md agent
 * notes + USER.md user profile), a single `memory` tool (add / replace /
 * remove, unique-substring matching, overflow discipline with
 * current-entries payloads), and a per-session frozen system-prompt
 * snapshot.
 *
 * @module dsh-memory-hermes
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-user-approval'
import { installMemoryCommand } from './command.js'
import { MemoryHermesGateway } from './gateway.js'
import { createSnapshotSection } from './prompt.js'
import { installReview } from './review.js'
import { MemoryStore } from './store.js'
import { buildMemoryTool } from './tool.js'
import type { ApprovalLike } from './tool.js'

export const name = 'memory-hermes'
export const inject = ['tools', 'systemPrompt']

/** User-tunable policy; char limits are configurable because dense scripts
 * (e.g. Chinese) may want different budgets than Hermes' English defaults. */
export interface Config {
  /** MEMORY.md serialized-codepoint budget. */
  memoryCharLimit?: number
  /** USER.md serialized-codepoint budget. */
  userCharLimit?: number
  /** Scan writes and rendered snapshots for injection-shaped content. */
  securityScan?: boolean
  /** Gate every memory write behind user approval. */
  approval?: boolean
  /** Hermes-style post-turn self-review: one background LLM call per
   * completed turn that saves anything worth remembering. Disabled
   * automatically while `approval` is on (a background write cannot ask). */
  backgroundReview?: boolean
  /** Review model override; defaults to the session's own provider/model,
   * which keeps the provider's prefix cache warm. */
  reviewProvider?: string
  reviewModel?: string
  /** Output budget of one review call. */
  reviewMaxTokens?: number
  /** Abort a review call after this long. */
  reviewTimeoutMs?: number
}

/** Schemastery config; drives Loader defaults and config docs. */
export const Config: z<Config> = z.object({
  memoryCharLimit: z.number().step(1).min(200).default(2200),
  userCharLimit: z.number().step(1).min(200).default(1375),
  securityScan: z.boolean().default(true),
  approval: z.boolean().default(false),
  backgroundReview: z.boolean().default(true),
  reviewProvider: z.string(),
  reviewModel: z.string(),
  reviewMaxTokens: z.number().step(1).min(1).default(1000),
  reviewTimeoutMs: z.number().step(1).min(1000).default(60_000),
})

/** Config with schema defaults applied; the model-override pair stays optional. */
type Resolved = Required<Omit<Config, 'reviewProvider' | 'reviewModel'>>
  & Pick<Config, 'reviewProvider' | 'reviewModel'>

export function apply(ctx: Context, config: Config): void {
  // Re-run the schema so defaults and bounds hold even when apply is called
  // directly, outside Loader normalization (schemastery fills and validates).
  const resolved = new Config(config) as Resolved
  const store = new MemoryStore({
    files: {
      memory: {
        path: dshHomePath('memory', 'MEMORY.md'),
        label: 'MEMORY.md',
        limit: resolved.memoryCharLimit,
      },
      user: {
        path: dshHomePath('memory', 'USER.md'),
        label: 'USER.md',
        limit: resolved.userCharLimit,
      },
    },
    securityScan: resolved.securityScan,
  })
  ctx.systemPrompt.section(createSnapshotSection(store, resolved.securityScan))
  ctx.tools.register(defineTool(buildMemoryTool({
    store,
    securityScan: resolved.securityScan,
    approval: resolved.approval,
    getApproval: () => ctx.get('approval') as ApprovalLike | undefined,
  })))
  installMemoryCommand(ctx, store)
  // Registers itself on construction; the web panel talks to it over RPC.
  new MemoryHermesGateway(ctx, store)
  // Background review cannot honor the approval gate (no open turn to ask
  // in), so the gate wins and the review stays off while approval is on.
  if (resolved.backgroundReview && !resolved.approval) {
    ctx.inject(['llm'], (scoped) => installReview(scoped, {
      store,
      config: {
        securityScan: resolved.securityScan,
        ...resolved.reviewProvider === undefined ? {} : { provider: resolved.reviewProvider },
        ...resolved.reviewModel === undefined ? {} : { model: resolved.reviewModel },
        maxTokens: resolved.reviewMaxTokens,
        timeoutMs: resolved.reviewTimeoutMs,
      },
    }))
  }
}
