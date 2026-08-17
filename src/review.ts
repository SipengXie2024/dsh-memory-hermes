/**
 * Hermes-style background self-review, v3: a bounded forked-agent loop with
 * Hermes' two-route split — memory (who the user is) and skills (how to do
 * this class of task) — instead of one LLM call that only writes memory.
 *
 * - Prompts are Hermes' own (background_review.py), adapted only where the
 *   harness differs. Memory narrows to user/preference/state; techniques go
 *   to the skill library via the fork's skills_list / skill_view /
 *   skill_manage tools.
 * - The fork loops (max reviewMaxSteps): model -> tool calls -> dispatch
 *   through the same guardrailed pipelines (memory: validate -> scan ->
 *   mutate; skills: provenance + read-before-write) -> tool results back in,
 *   until the model stops calling tools.
 * - Model routing is 1:1 with Hermes: same provider/model as the session ->
 *   full replay on the warm prefix cache; a different reviewProvider/Model ->
 *   compact digest replay (tail 24 + synthetic digest), because the cache is
 *   cold either way.
 * - Triggers, cost gate, harvest snapshotting, supersede/drain, and sidecar
 *   recording are unchanged from v2.
 *
 * Failure posture: best-effort. Errors are logged and recorded, never
 * retried, never surfaced into the conversation.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { usageHeader } from './errors.js'
import { runForkLoop, summarize } from './forkloop.js'
import type { ToolCallBlock } from './forkloop.js'
import type { ReviewKind, ReviewLog, ReviewRun } from './reviewlog.js'
import { scan } from './scan.js'
import type { ConfigSource } from './settings.js'
import { ForkSkillTools, SKILL_TOOL_NAMES, forkSkillToolSchemas } from './skills/tools.js'
import type { CuratorSkillStore } from './skills/store.js'
import type { SkillActionCounts, SkillMutationHooks } from './skills/tools.js'
import type { MemoryStore } from './store.js'
import { TOOL_NAME, validateMemoryArgs, writtenText } from './tool.js'
import { renderTopicValue, TOPIC_TOOL_NAME, TopicTools, forkTopicToolSchema } from './topics.js'
import type { TopicToolArgs } from './topics.js'

/** Memory-only prompt (skillReview off). Hermes' memory route is narrow by
 * design: user persona, preferences, behavior expectations, current state. */
export const REVIEW_INSTRUCTION = 'You are in a post-turn background review. The conversation '
  + 'above has paused; you are NOT talking to the user and nothing you produce here is shown '
  + 'to them. Your only job: decide whether this conversation revealed something worth saving '
  + 'to your persistent memory files that is not already there. Worth saving: things the user '
  + 'revealed about themselves (persona, preferences, personal details), expectations about '
  + 'how you should behave, durable environment facts and project state. Not worth saving: '
  + 'one-off task details, anything already present in the Persistent memory section of your '
  + 'system prompt, secrets or credentials. If something qualifies, call the memory tool '
  + '(add / replace / remove; one call per entry; single terse line each; respect the capacity '
  + 'discipline). Use no other tool. If nothing qualifies, reply with exactly NOTHING and make '
  + 'no tool calls.'

/** Memory-only compaction-harvest variant. */
export const HARVEST_INSTRUCTION = 'You are in a pre-compaction background harvest. The '
  + 'conversation above is about to be folded into a summary and its details will leave the '
  + 'model\u2019s working context; you are NOT talking to the user and nothing you produce here is '
  + 'shown to them. Your only job: decide whether this conversation revealed something worth '
  + 'saving to your persistent memory files that is not already there, before compaction hides '
  + 'the details. Worth saving: things the user revealed about themselves, expectations about '
  + 'how you should behave, durable environment facts and project state. Not worth saving: '
  + 'one-off task details, anything already present in the Persistent memory section of your '
  + 'system prompt, secrets or credentials. If something qualifies, call the memory tool '
  + '(add / replace / remove; one call per entry; single terse line each; respect the capacity '
  + 'discipline). Use no other tool. If nothing qualifies, reply with exactly NOTHING and make '
  + 'no tool calls.'

/**
 * The combined memory+skill prompt: Hermes' _COMBINED_REVIEW_PROMPT
 * (agent/background_review.py) with harness-specific references (curator
 * pin/adopt) neutralized. Text otherwise verbatim.
 */
export const COMBINED_REVIEW_INSTRUCTION = 'You are in a post-turn background review. The '
  + 'conversation above has paused; you are NOT talking to the user and nothing you produce '
  + 'here is shown to them. Review the conversation above and update two things:\n\n'
  + '**Memory**: who the user is. Did the user reveal persona, desires, preferences, personal '
  + 'details, or expectations about how you should behave? Save facts about the user and '
  + 'durable preferences with the memory tool (add / replace / remove; one call per entry; '
  + 'single terse line each; respect the capacity discipline).\n\n'
  + '**Skills**: how to do this class of task. Be ACTIVE — most sessions produce at least one '
  + 'skill update. A pass that does nothing is a missed learning opportunity, not a neutral '
  + 'outcome.\n\n'
  + 'Target shape of the skill library: CLASS-LEVEL skills with a rich SKILL.md and a '
  + '`references/` directory for session-specific detail. Not a long flat list of narrow '
  + 'one-session-one-skill entries.\n\n'
  + 'Signals that warrant a skill update (any one is enough):\n'
  + '  • User corrected your style, tone, format, legibility, verbosity, or approach. '
  + 'Frustration is a FIRST-CLASS skill signal, not just a memory signal. \'stop doing X\', '
  + '\'don\'t format like this\', \'I hate when you Y\' — embed the lesson in the skill that '
  + 'governs that task so the next session starts fixed.\n'
  + '  • Non-trivial technique, fix, workaround, or debugging path emerged.\n'
  + '  • A skill that was loaded or consulted turned out wrong, missing, or outdated — patch '
  + 'it now.\n\n'
  + 'Preference order for skills — pick the earliest that fits:\n'
  + '  1. UPDATE A CURRENTLY-LOADED SKILL. Check what skills were loaded or consulted in the '
  + 'conversation. If one of them covers the learning, PATCH it first. It was in play; it is '
  + 'the right place — provided it is curator-managed (created_by: agent). Protected and '
  + 'user-owned skills are off-limits however relevant; fall through when one of those is the '
  + 'best fit.\n'
  + '  2. UPDATE AN EXISTING UMBRELLA (skills_list + skill_view to find the right one). '
  + 'Patch it.\n'
  + '  3. ADD A SUPPORT FILE under an existing umbrella via skill_manage action=write_file. '
  + 'Three kinds: `references/<topic>.md` for session-specific detail OR condensed knowledge '
  + 'banks (quoted research, API docs excerpts, domain notes) written concise and '
  + 'task-focused; `templates/<name>.<ext>` for starter files meant to be copied and '
  + 'modified; `scripts/<name>.<ext>` for statically re-runnable actions (verification, '
  + 'fixture generators, probes). Add a one-line pointer in SKILL.md so future agents find '
  + 'them.\n'
  + '  4. CREATE A NEW CLASS-LEVEL UMBRELLA when nothing exists. Name at the class level — '
  + 'NOT a PR number, error string, codename, library-alone name, or \'fix-X / debug-Y\' '
  + 'session artifact. If the name only fits today\'s task, fall back to (1), (2), or (3).\n\n'
  + 'User-preference embedding: when the user complains about how you handled a task, update '
  + 'the skill that governs that task — memory alone is not enough. Memory says \'who the '
  + 'user is and what the current situation and state of your operations are\'; skills say '
  + '\'how to do this class of task for this user\'. Both should carry user-preference '
  + 'lessons when relevant.\n\n'
  + 'If you notice overlapping existing skills, mention it in your reply.\n\n'
  + 'Protected skills (DO NOT edit these):\n'
  + '  • Skills outside the curator library root (they belong to the harness or other '
  + 'plugins).\n'
  + '  • USER-OWNED skills — anything without the `created_by: agent` marker (hand-written, '
  + 'or created by a foreground agent at the user\'s request). Your writes to these WILL be '
  + 'refused, including to skills loaded or consulted this session. If one is wrong, say so '
  + 'in your reply instead of patching it.\n'
  + 'If the only skills that need updating are protected, say\n'
  + '\'Nothing to save.\' and stop.\n\n'
  + 'Do NOT capture as skills (these become persistent self-imposed constraints that bite '
  + 'you later when the environment changes):\n'
  + '  • Environment-dependent failures: missing binaries, fresh-install errors, '
  + 'post-migration path mismatches, \'command not found\', unconfigured credentials, '
  + 'uninstalled packages. The user can fix these — they are not durable rules.\n'
  + '  • Negative claims about tools or features (\'browser tools do not work\', \'X tool is '
  + 'broken\', \'cannot use Y from execute_code\'). These harden into refusals the agent '
  + 'cites against itself for months after the actual problem was fixed.\n'
  + '  • Session-specific transient errors that resolved before the conversation ended. If '
  + 'retrying worked, the lesson is the retry pattern, not the original failure.\n'
  + '  • One-off task narratives. A user asking \'summarize today\'s market\' or \'analyze '
  + 'this PR\' is not a class of work that warrants a skill.\n\n'
  + '  • Unresolved failures: if the session ended WITHOUT actually finding a working method '
  + '— you tried several things, none worked, and told the user to check manually — do NOT '
  + 'write those attempts up as a \'reliable workflow\' or \'recommended approach\'. That '
  + 'presents an untested sequence of failures as validated guidance a future session will '
  + 'trust and repeat. Either say \'Nothing to save\', or, only if you are independently '
  + 'confident of a real working alternative (not something you are merely guessing might '
  + 'work), capture ONLY that alternative — never the dead ends, and never dressed up as '
  + 'best practice.\n\n'
  + 'If a tool failed because of setup state, capture the FIX (install command, config step, '
  + 'env var to set) under an existing setup or troubleshooting skill — never \'this tool '
  + 'does not work\' as a standalone constraint.\n\n'
  + 'Act on whichever of the two dimensions has real signal. If genuinely nothing stands out '
  + 'on either, say \'Nothing to save.\' and stop — but don\'t reach for that conclusion as '
  + 'a default. Memory writes use the memory tool; skill work uses skills_list, skill_view, '
  + 'and skill_manage. Use no other tools.'

/** Compaction-harvest framing of the combined prompt. */
export const HARVEST_COMBINED_INSTRUCTION = 'You are in a pre-compaction background harvest. '
  + 'The conversation above is about to be folded into a summary and its details will leave '
  + 'the model\u2019s working context; you are NOT talking to the user and nothing you produce '
  + 'here is shown to them. Before compaction hides the details, update two things:\n\n'
  + COMBINED_REVIEW_INSTRUCTION.split('Review the conversation above and update two things:\n\n')[1]!

/**
 * Plugin addendum appended to every review instruction while the topic
 * detail layer is enabled (the Hermes prompt text itself stays verbatim).
 * Two positive examples and one counter-example — weak models follow
 * examples, not abstract routing rules.
 */
export const TOPIC_ADDENDUM = '\n\nMemory entries stay one line. When a fact needs more room, '
  + 'write the detail to a topic file (memory_topic tool: topic_write / topic_append) and keep '
  + 'the index entry to one line ending with `→ topics/<name>.md`. Every topic file must be '
  + 'referenced by at least one index entry. Topic file: the user\u2019s deployment topology. '
  + 'Topic file: this project\u2019s module responsibilities. NOT a topic file: how to debug a '
  + 'class of crashes — that belongs to a skill\u2019s references/.'

/** Structural view of the host-plane token meter (measured at trigger time). */
export interface TokenMeterLike {
  measure(session: Session): { totalTokens: number }
}

export interface ReviewDeps {
  readonly store: MemoryStore
  readonly configSource: ConfigSource
  readonly reviewLog?: ReviewLog
  readonly tokenMeter?: TokenMeterLike
  /** Present when the skill route is available (skillReview config on). */
  readonly skillStore?: CuratorSkillStore
  /** Telemetry callbacks hung on the fork's create/delete actions. */
  readonly skillHooks?: SkillMutationHooks
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
  /** Truncated text of each applied memory write, for the activity log. */
  readonly entries: readonly string[]
  /** Fork steps used (LLM calls in the loop). */
  readonly steps: number
  /** Skill mutations, when the skill route ran. */
  readonly skillActions?: SkillActionCounts
  /** Topic files mutated this pass (names only — content never lands here). */
  readonly topics?: readonly string[]
  /** Per-step tool-call trace lines (bounded), for the activity tab. */
  readonly trace?: readonly string[]
}

type SessionHeader = NonNullable<ReturnType<Session['requestHeader']>>

export interface ReviewCall {
  readonly session: Session
  readonly signal: AbortSignal
  /** Precomputed conversation input; defaults to the session's live state. */
  readonly snapshot?: { readonly header: SessionHeader; readonly messages: readonly Message[] }
  /** Overrides the default instruction (compaction harvest wording). */
  readonly instruction?: string
  /** User steering appended to the instruction (`/memory review [focus]`). */
  readonly focus?: string
}

/** Text content of one message, for the digest. */
function messageText(message: Message): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => (block as { type: 'text'; text: string }).text)
    .join(' ')
    .replace(/\n/g, ' ')
    .trim()
}

function isToolResultMessage(message: Message): boolean {
  return message.role === 'user' && message.content[0]?.type === 'tool-result'
}

/**
 * Compact replay for the routed (different-model) path only — Hermes'
 * `_digest_history`: keep the recent `tail` messages verbatim, collapse
 * older turns into one synthetic user-role digest.
 */
export function digestHistory(messages: readonly Message[], tail = 24): Message[] {
  if (messages.length <= tail) return [...messages]
  let keep = messages.slice(-tail)
  while (keep.length > 0 && isToolResultMessage(keep[0]!)) {
    tail += 1
    if (messages.length <= tail) return [...messages]
    keep = messages.slice(-tail)
  }
  const old = messages.slice(0, messages.length - keep.length)
  const lines: string[] = []
  for (const message of old) {
    const text = messageText(message)
    if (message.role === 'user' && text !== '' && !isToolResultMessage(message)) {
      lines.push(`USER: ${[...text].slice(0, 300).join('')}`)
    } else if (message.role === 'assistant') {
      const toolCalls = message.content.filter(block => block.type === 'tool-call')
      if (toolCalls.length > 0) {
        lines.push(`ASSISTANT[tools: ${toolCalls.map(block => (block as { name?: string }).name ?? '?').join(', ')}]`)
      }
      if (text !== '') lines.push(`ASSISTANT: ${[...text].slice(0, 200).join('')}`)
    }
  }
  const digest = createUserMessage({
    content: [{
      type: 'text',
      text: '[Earlier conversation digest — older turns summarised to bound the review\'s '
        + 'cold-write cost on the routed aux model. Recent turns follow verbatim below.]\n'
        + lines.join('\n'),
    }],
    source: { kind: 'plugin', plugin: 'dsh-memory-hermes' },
  })
  return [digest, ...keep]
}

/**
 * One review pass: a bounded fork loop. Each step streams the model; tool
 * calls are dispatched (memory pipeline, skill tools, or a foreign-call
 * refusal) and their results appended, until the model stops or the step
 * cap hits. Memory op failures count and skip — never loop on them.
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
  const skillEnabled = config.skillReview && deps.skillStore !== undefined
  const baseMessages = [...(call.snapshot?.messages ?? call.session.deriveMessages())]
  const provider = config.reviewProvider ?? header.config.provider
  const model = config.reviewModel ?? header.config.model
  const routed = provider !== header.config.provider || model !== header.config.model
  const replay = routed ? digestHistory(baseMessages) : baseMessages

  let instruction = call.instruction ?? (skillEnabled ? COMBINED_REVIEW_INSTRUCTION : REVIEW_INSTRUCTION)
  const topicsEnabled = config.topicsEnabled && deps.store.hasTopics()
  if (topicsEnabled) instruction += TOPIC_ADDENDUM
  const focus = call.focus?.trim()
  if (focus !== undefined && focus !== '') {
    instruction += `\n\nThe user explicitly requested this review with the following focus — prioritize it over the general instructions above:\n${focus}`
  }

  const messages: Message[] = [
    ...replay,
    createUserMessage({
      content: [{ type: 'text', text: instruction }],
      source: { kind: 'plugin', plugin: 'dsh-memory-hermes' },
    }),
  ]
  const tools = [
    ...(header.tools === undefined ? [] : [...header.tools]),
    ...(skillEnabled ? forkSkillToolSchemas() : []),
    // Self-provide the topic schema: sessions whose header predates the
    // tool (hot-reload survivors) would otherwise be taught an addendum
    // they cannot act on. Deduped by name — duplicate declarations make
    // providers reject the request.
    ...topicsEnabled && !(header.tools ?? []).some(tool => (tool as { name?: string }).name === TOPIC_TOOL_NAME)
      ? [forkTopicToolSchema()]
      : [],
  ] as unknown as NonNullable<GenerateOptions['tools']>
  const merged = deadline(call.signal, config.reviewTimeoutMs * Math.max(1, config.reviewMaxSteps))
  const forkTools = skillEnabled && deps.skillStore !== undefined ? new ForkSkillTools(deps.skillStore, deps.skillHooks) : undefined
  // Per-run topic executor: read-before-write evidence is scoped to this pass.
  const topicTools = topicsEnabled
    ? new TopicTools(
        deps.store,
        new Map(),
        () => {
          const c = deps.configSource.get()
          return { topicsEnabled: c.topicsEnabled, topicReadLines: c.topicReadLines, topicReadMaxBytes: c.topicReadMaxBytes }
        },
        () => deps.configSource.get().securityScan,
      )
    : undefined

  let applied = 0
  let rejected = 0
  let malformed = 0
  let foreign = 0
  const entries: string[] = []
  const topicsTouched: string[] = []

  const dispatchMemory = async (toolCall: ToolCallBlock): Promise<{ text: string; isError: boolean }> => {
    let args: Parameters<typeof validateMemoryArgs>[0]
    try {
      const parsed: unknown = JSON.parse(toolCall.arguments)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
      args = parsed as Parameters<typeof validateMemoryArgs>[0]
    } catch {
      malformed += 1
      return { text: 'invalid memory tool arguments: expected a JSON object', isError: true }
    }
    try {
      const validated = validateMemoryArgs(args)
      const written = writtenText(validated.op)
      if (config.securityScan && written !== undefined && scan(written) !== undefined) {
        rejected += 1
        return { text: 'Write rejected by the memory security scan.', isError: true }
      }
      const result = await deps.store.mutate(validated.file, validated.op)
      applied += 1
      if (written !== undefined) entries.push(summarize(written))
      const label = validated.file === 'user' ? 'USER.md' : 'MEMORY.md'
      return { text: `Saved. ${label} is now ${usageHeader(result.chars, result.limit)}, ${result.entries} entries.`, isError: false }
    } catch (error) {
      rejected += 1
      const message = error instanceof Error ? error.message.split('\n')[0]! : String(error)
      ctx.logger.warn(`memory-hermes review: op dropped: ${message}`)
      return { text: message, isError: true }
    }
  }

  /**
   * Topic dispatch: same JSON parse posture as memory. Topic failures do
   * NOT count into applied/rejected/malformed (those are memory-write
   * counters the panel renders as "saved N memory entries"); the trace
   * line records the failure instead. Mutated topic names go to `topics`.
   */
  const dispatchTopic = async (toolCall: ToolCallBlock): Promise<{ text: string; isError: boolean }> => {
    if (topicTools === undefined) {
      return { text: 'topic files are not available in this configuration', isError: true }
    }
    let args: TopicToolArgs
    try {
      const parsed: unknown = JSON.parse(toolCall.arguments)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
      args = parsed as TopicToolArgs
    } catch {
      return { text: 'invalid memory_topic arguments: expected a JSON object', isError: true }
    }
    try {
      const value = await topicTools.execute(args)
      if (value.name !== undefined && value.action !== 'topic_read' && value.action !== 'topic_list') {
        if (!topicsTouched.includes(value.name)) topicsTouched.push(value.name)
      }
      return { text: renderTopicValue(value), isError: false }
    } catch (error) {
      const message = error instanceof Error ? error.message.split('\n')[0]! : String(error)
      ctx.logger.warn(`memory-hermes review: topic op dropped: ${message}`)
      return { text: message, isError: true }
    }
  }

  const loop = await runForkLoop(ctx, {
    provider,
    model,
    messages,
    ...header.system === undefined ? {} : { system: header.system },
    tools,
    maxSteps: config.reviewMaxSteps,
    maxTokens: config.reviewMaxTokens,
    signal: merged,
    sessionId: call.session.id,
    dispatch: async (toolCall) => {
      if (toolCall.name === TOOL_NAME) return dispatchMemory(toolCall)
      if (toolCall.name === TOPIC_TOOL_NAME) return dispatchTopic(toolCall)
      if (forkTools !== undefined && (SKILL_TOOL_NAMES as readonly string[]).includes(toolCall.name)) {
        return forkTools.execute(toolCall.name, toolCall.arguments)
      }
      foreign += 1
      return { text: `tool "${toolCall.name}" is not available in a background review`, isError: true }
    },
  })

  return {
    applied,
    rejected,
    malformed,
    foreign,
    entries,
    steps: loop.steps,
    ...forkTools === undefined ? {} : { skillActions: forkTools.counts },
    ...topicsTouched.length === 0 ? {} : { topics: topicsTouched },
    ...loop.trace.length === 0 ? {} : { trace: loop.trace },
  }
}

interface SessionReviewState {
  lastReviewedTurn: number
  controller: AbortController | undefined
  /** token-delta mode: request pressure at the last fired (or baselined) review. */
  pressureBaseline: number | undefined
}

export interface ReviewControl {
  /** Fire a manual review over the agent's live session (`/memory review [focus]`). */
  triggerNow(agent: Agent, focus?: string): void
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
    focus?: string
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
      ...params.focus === undefined ? {} : { focus: params.focus },
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
          ...outcome?.steps !== undefined ? { steps: outcome.steps } : {},
          ...outcome?.skillActions === undefined ? {} : { skillActions: outcome.skillActions },
          ...outcome?.topics === undefined ? {} : { topics: [...outcome.topics] },
          ...outcome?.trace === undefined ? {} : { trace: [...outcome.trace] },
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
      const harvestInstruction = config.skillReview && deps.skillStore !== undefined
        ? HARVEST_COMBINED_INSTRUCTION
        : HARVEST_INSTRUCTION
      launch({ session, turn: typeof event.data.turn === 'number' ? event.data.turn : -1, kind: 'compaction', snapshot, instruction: harvestInstruction })
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
    triggerNow(agent, focus) {
      const sessions = ctx.get('sessions') as { get(id: unknown): Session | undefined } | undefined
      const session = sessions?.get(agent.id)
      if (session === undefined) {
        ctx.logger.warn('memory-hermes review: manual trigger found no live session for this agent')
        return
      }
      launch({
        session,
        turn: states.get(String(session.id))?.lastReviewedTurn ?? -1,
        kind: 'manual',
        ...focus === undefined ? {} : { focus },
      })
    },
  }
}
