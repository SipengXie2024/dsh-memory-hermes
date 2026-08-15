/**
 * Plugin configuration vocabulary. One schemastery schema serves two
 * composition layers: the Loader validates the bundle-patch entry config
 * with it, and settings.ts registers the SAME shape as a settings namespace
 * with the entry config as `base` — so a bundle patch stays the composition
 * floor and the user document overrides it live.
 *
 * @module dsh-memory-hermes/config
 */

import z from '@deepseek-ai/schemastery'

/** User-tunable policy; char limits are configurable because dense scripts
 * (e.g. Chinese) may want different budgets than Hermes' English defaults. */
export interface Config {
  /** MEMORY.md serialized-codepoint budget. */
  memoryCharLimit?: number
  /** USER.md serialized-codepoint budget. */
  userCharLimit?: number
  /** Scan writes and rendered snapshots for injection-shaped content. */
  securityScan?: boolean
  /** Gate every model-initiated memory write behind user approval. */
  approval?: boolean
  /** Hermes-style post-turn self-review. */
  backgroundReview?: boolean
  /** Review model override; defaults to the session's own provider/model,
   * which keeps the provider's prefix cache warm. */
  reviewProvider?: string
  reviewModel?: string
  /** Output budget of one review call. */
  reviewMaxTokens?: number
  /** Abort a review call after this long. */
  reviewTimeoutMs?: number
  /** Turn-end trigger policy:
   * - `every-turn`: review every completed turn (cheapest with a prefix-caching provider);
   * - `token-delta`: review only once the session grew by reviewTokenDeltaTokens;
   * - `manual`: only `/memory review` and compaction harvests run. */
  reviewTrigger?: 'every-turn' | 'token-delta' | 'manual'
  /** token-delta threshold in estimated tokens (tokenMeter heuristic). */
  reviewTokenDeltaTokens?: number
  /** Run a harvest review when compaction folds context away. */
  compactionHarvest?: boolean
  /** Retained review-run records in the activity sidecar. */
  reviewHistoryLimit?: number
  /** Output budget of one /memory compact consolidation call. */
  consolidateMaxTokens?: number
  /** Skill route of the review fork: techniques become skills, not memory
   * entries (Hermes' two-route split). */
  skillReview?: boolean
  /** Maximum LLM steps in one review fork loop. */
  reviewMaxSteps?: number
  /** Curator skill library root; defaults to `$DSH_HOME/skills` (dsh's own
   * user skill root, so new skills appear in every session's catalog). */
  skillRoot?: string
  /** Per-file byte cap for skill writes. */
  skillMaxBytes?: number
}

/** Schemastery config; drives Loader defaults, settings UI, and config docs. */
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
  reviewTrigger: z.union(['every-turn', 'token-delta', 'manual']).default('token-delta'),
  reviewTokenDeltaTokens: z.number().step(1).min(100).default(4000),
  compactionHarvest: z.boolean().default(true),
  reviewHistoryLimit: z.number().step(1).min(10).default(200),
  consolidateMaxTokens: z.number().step(1).min(200).default(2000),
  skillReview: z.boolean().default(true),
  reviewMaxSteps: z.number().step(1).min(1).max(32).default(8),
  skillRoot: z.string(),
  skillMaxBytes: z.number().step(1).min(1024).default(65536),
})

/** Config with schema defaults applied; the model-override pair and the
 * optional skill-root override stay optional. */
export type Resolved = Required<Omit<Config, 'reviewProvider' | 'reviewModel' | 'skillRoot'>>
  & Pick<Config, 'reviewProvider' | 'reviewModel' | 'skillRoot'>
