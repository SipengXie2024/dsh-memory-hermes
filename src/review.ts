/**
 * Hermes-style background self-review, upgraded for dsh's own mechanics:
 *
 * - Triggers: turn/end (policy-gated: every-turn | token-delta | manual),
 *   compaction/start (pre-fold harvest — dsh's real forgetting point), and
 *   `/memory review` (manual). The harvest snapshots the conversation
 *   SYNCHRONOUSLY in the event callback: session/event is fire-and-forget,
 *   and once compaction lands, deriveMessages() returns less.
 * - Cost: token-delta mode prices the session with tokenMeter between
 *   reviews, so providers without a prefix cache stop paying a full-prefix
 *   call per turn.
 * - Observability: every settled pass is recorded to the review sidecar
 *   (reviewlog.ts) — "ran but saved nothing" vs "never ran" is answerable.
 *
 * The call still mirrors dsh's own auxiliary calls (compaction summarizer,
 * session-title): reuse the session's system + tools + message prefix so
 * the provider's KV cache is reused; it goes through ctx.llm.stream
 * directly — never the agent loop, so it produces no turn events and can
 * never trigger itself.
 *
 * Failure posture: best-effort. Errors are logged and recorded, never
 * retried, never surfaced into the conversation.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ReviewKind, ReviewLog, ReviewRun } from './reviewlog.js'
import { scan } from './scan.js'
import type { ConfigSource } from './settings.js'
import type { MemoryStore } from './store.js'
import { TOOL_NAME, validateMemoryArgs, writtenText } from './tool.js'
import type { MemoryToolArgs } from './tool.js'

/**
 * The only novel input of the review call. The session's own tool schemas
 * ride along for cache fidelity, so the instruction must scope the model to
 * the memory tool alone — and parseReviewOps enforces that structurally by
 * ignoring every other tool call.
 */
export const REVIEW_INSTRUCTION = 'You are in a post-turn background review. The conversation '
  + 'above has paused; you are NOT talking to the user and nothing you produce here is shown '
  + 'to them. Your only job: decide whether this conversation revealed something worth saving '
  + 'to your persistent memory files that is not already there. Worth saving: corrections the '
  + 'user made, stable preferences, environment facts, conventions, hard-won pitfalls. Not '
  + 'worth saving: one-off task details, anything already present in the Persistent memory '
  + 'section of your system prompt, secrets or credentials. If something qualifies, call the '
  + 'memory tool (add / replace / remove; one call per entry; single terse line each; respect '
  + 'the capacity discipline). Use no other tool. If nothing qualifies, reply with exactly '
  + 'NOTHING and make no tool calls.'

/** Compaction-start variant: the details are about to leave the context. */
export const HARVEST_INSTRUCTION = 'You are in a pre-compaction background harvest. The '
  + 'conversation above is about to be folded into a summary and its details will leave the '
  + 'model\u2019s working context; you are NOT talking to the user and nothing you produce here is '
  + 'shown to them. Your only job: decide whether this conversation revealed something worth '
  + 'saving to your persistent memory files that is not already there, before compaction hides '
  + 'the details. Worth saving: corrections the user made, stable preferences, environment '
  + 'facts, conventions, hard-won pitfalls. Not worth saving: one-off task details, anything '
  + 'already present in the Persistent memory section of your system prompt, secrets or '
  + 'credentials. If something qualifies, call the memory tool (add / replace / remove; one '
  + 'call per entry; single terse line each; respect the capacity discipline). Use no other '
  + 'tool. If nothing qualifies, reply with exactly NOTHING and make no tool calls.'

/** Structural view of the host-plane token meter (measured at trigger time). */
export interface TokenMeterLike {
  measure(session: Session): { totalTokens: number }
}

export interface ReviewDeps {
  readonly store: MemoryStore
  readonly configSource: ConfigSource
  readonly reviewLog?: ReviewLog
  readonly tokenMeter?: TokenMeterLike
}

export interface ParsedReviewOps {
  /** Arguments of every memory tool call, in emission order. */
  readonly ops: readonly MemoryToolArgs[]
  /** memory-tool calls whose arguments were not valid JSON objects. */
  readonly malformed: number
  /** Calls to tools other than memory (instruction violations; never executed). */
  readonly foreign: number
}

/** Extract memory ops from a review reply, ignoring everything else. */
export function parseReviewOps(blocks: readonly ContentBlock[]): ParsedReviewOps {
  const ops: MemoryToolArgs[] = []
  let malformed = 0
  let foreign = 0
  for (const block of blocks) {
    if (block.type !== 'tool-call') continue
    if (block.name !== TOOL_NAME) {
      foreign += 1
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(block.arguments)
    } catch {
      malformed += 1
      continue
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      malformed += 1
      continue
    }
    // validateMemoryArgs re-checks every field defensively (enums, typeof),
    // so a structural cast is all the trust this needs.
    ops.push(parsed as MemoryToolArgs)
  }
  return { ops, malformed, foreign }
}

/** Merge an upstream signal with a timeout; <=0 disables the timer. */
export function deadline(upstream: AbortSignal, timeoutMs: number): AbortSignal {
  if (timeoutMs <= 0) return upstream
  return AbortSignal.any([upstream, AbortSignal.timeout(timeoutMs)])
}

export interface ReviewOutcome {
  readonly applied: number
  readonly rejected: number
  readonly malformed: number
  readonly foreign: number
  /** Truncated text of each applied write, for the activity log. */
  readonly entries: readonly string[]
}

type SessionHeader = NonNullable<ReturnType<Session['requestHeader']>>

export interface ReviewCall {
  readonly session: Session
  readonly signal: AbortSignal
  /** Precomputed conversation input; defaults to the session's live state. */
  readonly snapshot?: { readonly header: SessionHeader; readonly messages: readonly Message[] }
  /** Overrides REVIEW_INSTRUCTION (the compaction harvest wording). */
  readonly instruction?: string
}

function summarize(text: string): string {
  return [...text].length <= 80 ? text : `${[...text].slice(0, 80).join('')}...`
}

/**
 * One review pass over a session: auxiliary LLM call, then replay the memory
 * ops it emitted through the same validate -> scan -> mutate pipeline the
 * live tool uses. Individual op failures (overflow, ambiguous target) are
 * counted and skipped — a background task must not loop on them.
 */
export async function reviewOnce(
  ctx: Context,
  deps: ReviewDeps,
  call: ReviewCall,
): Promise<ReviewOutcome | undefined> {
  const header = call.snapshot?.header ?? call.session.requestHeader()
  // A session that never routed a request has nothing to review against.
  if (header === undefined) return undefined
  const config = deps.configSource.get()
  const messages: Message[] = [
    ...(call.snapshot?.messages ?? call.session.deriveMessages()),
    createUserMessage({
      content: [{ type: 'text', text: call.instruction ?? REVIEW_INSTRUCTION }],
      source: { kind: 'plugin', plugin: 'dsh-memory-hermes' },
    }),
  ]
  const merged = deadline(call.signal, config.reviewTimeoutMs)
  const options: GenerateOptions = {
    provider: config.reviewProvider ?? header.config.provider,
    model: config.reviewModel ?? header.config.model,
    messages,
    ...header.system === undefined ? {} : { system: header.system },
    ...header.tools === undefined ? {} : { tools: [...header.tools] },
    maxTokens: config.reviewMaxTokens,
    sessionId: call.session.id,
    signal: merged,
  }
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) {
    merged.throwIfAborted()
    assembler.push(chunk)
  }
  const finish = assembler.finish
  if (finish.kind === 'aborted' || finish.kind === 'error') {
    throw new Error(`review call did not finish cleanly (${finish.kind})`)
  }
  const parsed = parseReviewOps(assembler.blocks())
  let applied = 0
  let rejected = 0
  const entries: string[] = []
  for (const args of parsed.ops) {
    try {
      const validated = validateMemoryArgs(args)
      const written = writtenText(validated.op)
      if (config.securityScan && written !== undefined && scan(written) !== undefined) {
        rejected += 1
        continue
      }
      await deps.store.mutate(validated.file, validated.op)
      applied += 1
      if (written !== undefined) entries.push(summarize(written))
    } catch (error) {
      rejected += 1
      ctx.logger.warn(`memory-hermes review: op dropped: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    }
  }
  return { applied, rejected, malformed: parsed.malformed, foreign: parsed.foreign, entries }
}

interface SessionReviewState {
  lastReviewedTurn: number
  controller: AbortController | undefined
  /** token-delta mode: request pressure at the last fired (or baselined) review. */
  pressureBaseline: number | undefined
}

export interface ReviewControl {
  /** Fire a manual review over the agent's live session (`/memory review`). */
  triggerNow(agent: Agent): void
}

const newState = (): SessionReviewState => ({ lastReviewedTurn: -1, controller: undefined, pressureBaseline: undefined })

/** The compaction/* vocabulary merges into SessionEventMap from the
 * compaction package, which an out-of-tree plugin need not depend on; this
 * structural arm keeps the harvest listener type-safe without that import. */
type SessionEventLike = SessionEvent | {
  type: 'compaction/start'
  seq: number
  time: number
  data: { compactionId: string; turn?: number | null }
}

/**
 * Wire the review loop onto the session event firehose. `session/event` is
 * fire-and-forget (never awaited by the agent loop), so listening here can
 * never delay the turn boundary; reviews run as detached promises drained on
 * plugin disposal. A newer trigger supersedes an in-flight review — the new
 * pass sees the whole conversation anyway. Policy flags are read at fire
 * time, so a settings commit toggles review behavior live.
 */
export function installReview(ctx: Context, deps: ReviewDeps): ReviewControl {
  const states = new Map<string, SessionReviewState>()
  const inflight = new Set<Promise<unknown>>()
  const lifetime = new AbortController()
  ctx.effect(() => async () => {
    lifetime.abort(new Error('memory-hermes review disposed'))
    while (inflight.size > 0) await Promise.allSettled([...inflight])
  }, 'memory-hermes: drain background reviews')

  const launch = (params: {
    session: Session
    turn: number
    kind: ReviewKind
    snapshot?: { header: SessionHeader; messages: readonly Message[] }
    instruction?: string
  }): void => {
    const id = String(params.session.id)
    const state = states.get(id) ?? newState()
    state.controller?.abort(new Error('superseded by a newer review'))
    const controller = new AbortController()
    state.controller = controller
    if (params.kind === 'turn') state.lastReviewedTurn = params.turn
    states.set(id, state)
    const startedAt = Date.now()
    const signal = AbortSignal.any([controller.signal, lifetime.signal])
    const run = reviewOnce(ctx, deps, {
      session: params.session,
      signal,
      ...params.snapshot === undefined ? {} : { snapshot: params.snapshot },
      ...params.instruction === undefined ? {} : { instruction: params.instruction },
    })
      .then(async (outcome) => {
        const entry: ReviewRun = {
          id: crypto.randomUUID(),
          sessionId: id,
          turn: params.turn,
          kind: params.kind,
          startedAt,
          settledAt: Date.now(),
          applied: outcome?.applied ?? 0,
          rejected: outcome?.rejected ?? 0,
          malformed: outcome?.malformed ?? 0,
          foreign: outcome?.foreign ?? 0,
          ...outcome !== undefined && outcome.entries.length > 0 ? { entries: [...outcome.entries] } : {},
          ...outcome === undefined ? { error: 'session has no routed request header' } : {},
        }
        await deps.reviewLog?.record(entry).catch((error: unknown) => {
          ctx.logger.warn(`memory-hermes: review log write failed: ${error instanceof Error ? error.message : String(error)}`)
        })
        if (outcome !== undefined && (outcome.applied > 0 || outcome.rejected > 0)) {
          ctx.logger.info(`memory-hermes review: turn ${params.turn}: applied ${outcome.applied}, dropped ${outcome.rejected}`)
        }
      })
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        await deps.reviewLog?.record({
          id: crypto.randomUUID(),
          sessionId: id,
          turn: params.turn,
          kind: params.kind,
          startedAt,
          settledAt: Date.now(),
          applied: 0,
          rejected: 0,
          malformed: 0,
          foreign: 0,
          error: message,
        }).catch(() => {})
        ctx.logger.warn(`memory-hermes review failed: ${message}`)
      })
    inflight.add(run)
    void run.then(() => inflight.delete(run), () => inflight.delete(run))
  }

  ctx.on('agent/session-start', ({ agent, source }) => {
    // A cleared conversation restarts turn numbering; stale high-water marks
    // would silently suppress every future review.
    if (source === 'clear') states.delete(String(agent.id))
  })

  ctx.on('session/event', (session, rawEvent) => {
    const event = rawEvent as SessionEventLike
    const config = deps.configSource.get()
    // The approval gate wins: a background write cannot ask, so the review
    // stays off while model-initiated writes require approval.
    if (!config.backgroundReview || config.approval) return
    if (event.type === 'compaction/start') {
      if (!config.compactionHarvest) return
      // Snapshot NOW: the fold may land before an async review would read
      // the surface, and deriveMessages() then returns less.
      const header = session.requestHeader()
      if (header === undefined) return
      const snapshot = { header, messages: session.deriveMessages() }
      const id = String(session.id)
      const state = states.get(id) ?? newState()
      if (deps.tokenMeter !== undefined) {
        // The harvest read everything; do not let the next turn-end re-fire
        // on the same content.
        state.pressureBaseline = deps.tokenMeter.measure(session).totalTokens
        states.set(id, state)
      }
      launch({ session, turn: typeof event.data.turn === 'number' ? event.data.turn : -1, kind: 'compaction', snapshot, instruction: HARVEST_INSTRUCTION })
      return
    }
    if (event.type !== 'turn/end') return
    if (event.data.reason.kind !== 'completed') return
    if (config.reviewTrigger === 'manual') return
    const id = String(session.id)
    const state = states.get(id) ?? newState()
    if (event.data.turn <= state.lastReviewedTurn) return
    if (config.reviewTrigger === 'token-delta' && deps.tokenMeter !== undefined) {
      const pressure = deps.tokenMeter.measure(session).totalTokens
      if (state.pressureBaseline === undefined) {
        // First contact with this session (start or resume): baseline only,
        // so a long resumed log does not fire an immediate review.
        state.pressureBaseline = pressure
        states.set(id, state)
        return
      }
      if (pressure - state.pressureBaseline < config.reviewTokenDeltaTokens) return
      state.pressureBaseline = pressure
    }
    launch({ session, turn: event.data.turn, kind: 'turn' })
  })

  return {
    triggerNow(agent) {
      const sessions = ctx.get('sessions') as { get(id: unknown): Session | undefined } | undefined
      const session = sessions?.get(agent.id)
      if (session === undefined) {
        ctx.logger.warn('memory-hermes review: manual trigger found no live session for this agent')
        return
      }
      launch({ session, turn: states.get(String(session.id))?.lastReviewedTurn ?? -1, kind: 'manual' })
    },
  }
}
