/**
 * Hermes-style background self-review: after each cleanly completed turn, a
 * detached auxiliary LLM call replays the conversation and asks "did this
 * turn reveal anything worth saving to persistent memory?" — memory upkeep
 * without stealing attention from the main conversation.
 *
 * Shape mirrors dsh's own auxiliary calls (compaction summarizer,
 * session-title): reuse the session's system + tools + message prefix so the
 * call is a true prefix of the last routed request and the provider's KV
 * cache is reused; the review instruction is the only novel input. The call
 * goes through ctx.llm.stream directly — it never enters the agent loop, so
 * it produces no turn events and can never trigger itself.
 *
 * Failure posture: background reviews are best-effort. Errors are logged and
 * swallowed, never retried, never surfaced into the conversation.
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { scan } from './scan.js'
import type { MemoryStore } from './store.js'
import { TOOL_NAME, validateMemoryArgs, writtenText } from './tool.js'
import type { MemoryToolArgs } from './tool.js'

export interface ReviewConfig {
  readonly securityScan: boolean
  /** Override the review model; defaults to the session's own (keeps the KV cache). */
  readonly provider?: string
  readonly model?: string
  readonly maxTokens: number
  readonly timeoutMs: number
}

export interface ReviewDeps {
  readonly store: MemoryStore
  readonly config: ReviewConfig
}

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
}

/**
 * One review pass over a session: auxiliary LLM call, then replay the memory
 * ops it emitted through the same validate -> scan -> mutate pipeline the
 * live tool uses. Individual op failures (overflow, ambiguous target) are
 * counted and skipped — a background task must not loop on them.
 */
export async function reviewOnce(
  ctx: Context,
  session: Session,
  deps: ReviewDeps,
  signal: AbortSignal,
): Promise<ReviewOutcome | undefined> {
  const header = session.requestHeader()
  // A session that never routed a request has nothing to review against.
  if (header === undefined) return undefined
  const messages: Message[] = [
    ...session.deriveMessages(),
    createUserMessage({
      content: [{ type: 'text', text: REVIEW_INSTRUCTION }],
      source: { kind: 'plugin', plugin: 'dsh-memory-hermes' },
    }),
  ]
  const merged = deadline(signal, deps.config.timeoutMs)
  const options: GenerateOptions = {
    provider: deps.config.provider ?? header.config.provider,
    model: deps.config.model ?? header.config.model,
    messages,
    ...header.system === undefined ? {} : { system: header.system },
    ...header.tools === undefined ? {} : { tools: [...header.tools] },
    maxTokens: deps.config.maxTokens,
    sessionId: session.id,
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
  for (const args of parsed.ops) {
    try {
      const call = validateMemoryArgs(args)
      const written = writtenText(call.op)
      if (deps.config.securityScan && written !== undefined && scan(written) !== undefined) {
        rejected += 1
        continue
      }
      await deps.store.mutate(call.file, call.op)
      applied += 1
    } catch (error) {
      rejected += 1
      ctx.logger.warn(`memory-hermes review: op dropped: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    }
  }
  return { applied, rejected, malformed: parsed.malformed, foreign: parsed.foreign }
}

interface SessionReviewState {
  lastReviewedTurn: number
  controller: AbortController | undefined
}

/**
 * Wire the review loop onto the session event firehose. `session/event` is
 * fire-and-forget (never awaited by the agent loop), so listening here can
 * never delay the turn boundary; reviews run as detached promises drained on
 * plugin disposal. A newer turn supersedes an in-flight review — the new
 * pass sees the whole conversation anyway.
 */
export function installReview(ctx: Context, deps: ReviewDeps): void {
  const states = new Map<string, SessionReviewState>()
  const inflight = new Set<Promise<unknown>>()
  const lifetime = new AbortController()
  ctx.effect(() => async () => {
    lifetime.abort(new Error('memory-hermes review disposed'))
    while (inflight.size > 0) await Promise.allSettled([...inflight])
  }, 'memory-hermes: drain background reviews')

  ctx.on('agent/session-start', ({ agent, source }) => {
    // A cleared conversation restarts turn numbering; stale high-water marks
    // would silently suppress every future review.
    if (source === 'clear') states.delete(String(agent.id))
  })

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    if (event.data.reason.kind !== 'completed') return
    const id = String(session.id)
    const state = states.get(id) ?? { lastReviewedTurn: -1, controller: undefined }
    if (event.data.turn <= state.lastReviewedTurn) return
    state.controller?.abort(new Error('superseded by a newer turn'))
    const controller = new AbortController()
    states.set(id, { lastReviewedTurn: event.data.turn, controller })
    const run = reviewOnce(ctx, session, deps, AbortSignal.any([controller.signal, lifetime.signal]))
      .then((outcome) => {
        if (outcome !== undefined && (outcome.applied > 0 || outcome.rejected > 0)) {
          ctx.logger.info(`memory-hermes review: turn ${event.data.turn}: applied ${outcome.applied}, dropped ${outcome.rejected}`)
        }
      })
      .catch((error) => {
        ctx.logger.warn(`memory-hermes review failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    inflight.add(run)
    void run.then(() => inflight.delete(run), () => inflight.delete(run))
  })
}
