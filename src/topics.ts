/**
 * The `memory_topic` tool: the progressive-disclosure detail layer. Index
 * entries in MEMORY.md/USER.md stay one line; detail (commands, examples,
 * debugging narratives) lives in $DSH_HOME/memory/topics/<name>.md and is
 * read back on demand — nothing here ever enters the system prompt.
 *
 * One executor (TopicTools) serves both surfaces: the foreground tool
 * (per-session read-before-write evidence, keyed by Agent) and the review
 * fork (per-run evidence, a fresh executor per pass). The canonical value
 * is one flat shape — the dsh output-schema dialect forbids oneOf sibling
 * keywords, so branches are expressed as optional fields instead.
 *
 * @module dsh-memory-hermes/topics
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { scanBulkRejectedError } from './errors.js'
import { scanBulk } from './scan.js'
import type { MemoryStore, TopicInfo } from './store.js'

export const TOPIC_TOOL_NAME = 'memory_topic'

export const TOPIC_ACTIONS = ['topic_list', 'topic_read', 'topic_write', 'topic_append', 'topic_remove'] as const
export type TopicAction = (typeof TOPIC_ACTIONS)[number]

/** Actions that never destroy content; the approval gate whitelists these. */
export const READ_ONLY_ACTIONS: readonly string[] = ['topic_list', 'topic_read']

export interface TopicToolArgs {
  readonly action?: string
  readonly name?: string
  readonly content?: string
  readonly offset?: number
  readonly limit?: number
}

/** Live-read settings slice the executor needs. */
export interface TopicTunables {
  readonly topicsEnabled: boolean
  readonly topicReadLines: number
  readonly topicReadMaxBytes: number
}

export interface TopicListEntry {
  name: string
  bytes: number
  orphan: boolean
}

/** Flat canonical value; optional fields are conditionally spread, never undefined.
 *  Arrays are mutable because defineTool infers the canonical type from the
 *  output schema, and the inferred arrays are mutable. */
export interface TopicValue {
  readonly action: TopicAction
  name?: string
  bytes?: number
  cap?: number
  lines?: string[]
  totalLines?: number
  /** topic_read: the 1-based offset this page started at (drives the continuation hint). */
  offset?: number
  truncated?: boolean
  topics?: TopicListEntry[]
}

export interface ValidatedTopicCall {
  readonly action: TopicAction
  readonly name?: string
  readonly content?: string
  readonly offset?: number
  readonly limit?: number
}

function invalid(detail: string): HarnessError {
  return new HarnessError(`Invalid ${TOPIC_TOOL_NAME} arguments: ${detail}`, 'MEMORY_INVALID_ARGS')
}

function present(value: string | undefined): value is string {
  return typeof value === 'string' && value !== ''
}

function meaningful(value: string | undefined): value is string {
  // typeof-based so a null smuggled past JSON.parse (the fork dispatches
  // direct execute() calls) fails validation instead of crashing .trim().
  return typeof value === 'string' && value.trim() !== ''
}

function requireName(args: TopicToolArgs): string {
  if (!meaningful(args.name)) throw invalid(`${args.action} requires a topic name.`)
  return args.name!.trim()
}

function requireContent(args: TopicToolArgs): string {
  if (typeof args.content !== 'string' || args.content === '') {
    throw invalid(`${args.action} requires non-empty content.`)
  }
  return args.content
}

function rejectContent(args: TopicToolArgs): void {
  if (args.content !== undefined) throw invalid(`${args.action} takes no content.`)
}

function readWindow(args: TopicToolArgs): { offset?: number; limit?: number } {
  for (const [key, value] of [['offset', args.offset], ['limit', args.limit]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw invalid(`${key} must be a positive integer (offset is 1-based).`)
    }
  }
  return {
    ...args.offset === undefined ? {} : { offset: args.offset },
    ...args.limit === undefined ? {} : { limit: args.limit },
  }
}

function rejectWindow(args: TopicToolArgs): void {
  if (args.offset !== undefined || args.limit !== undefined) {
    throw invalid(`${args.action} takes no offset/limit.`)
  }
}

/** Validate raw tool arguments into one discriminated call. */
export function validateTopicArgs(args: TopicToolArgs): ValidatedTopicCall {
  switch (args.action) {
    case 'topic_list':
      if (present(args.name)) throw invalid('topic_list takes no name.')
      rejectContent(args)
      rejectWindow(args)
      return { action: 'topic_list' }
    case 'topic_read':
      rejectContent(args)
      return { action: 'topic_read', name: requireName(args), ...readWindow(args) }
    case 'topic_write':
      rejectWindow(args)
      return { action: 'topic_write', name: requireName(args), content: requireContent(args) }
    case 'topic_append':
      rejectWindow(args)
      return { action: 'topic_append', name: requireName(args), content: requireContent(args) }
    case 'topic_remove':
      rejectContent(args)
      rejectWindow(args)
      return { action: 'topic_remove', name: requireName(args) }
    default:
      throw invalid(`unknown action "${String(args.action)}" (${TOPIC_ACTIONS.join(' / ')}).`)
  }
}

/** Whether an index entry list references topics/<name>.md. The prefix check
 *  excludes letters/digits/dashes so `topology` does not match
 *  `deploy-topology.md` (a dash would create a regex word boundary). */
export function isReferenced(name: string, indexText: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^A-Za-z0-9-])${escaped}\\.md\\b`).test(indexText)
}

/** Human byte size (`3.9 kB`), for tool results and the /memory topics listing. */
export function formatKib(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} kB`
}

/**
 * One execution context's read-before-write evidence. `coveredThrough` is
 * the highest line number CONTIGUOUSLY read from the top (gap reads do not
 * advance it); `lines`/`bytes` describe the file as last observed. The gate
 * derives completeness at decision time — coveredThrough >= current lines
 * AND bytes == current size — so a file changed since the last read (e.g.
 * by a background review fork) automatically re-closes the gate, while a
 * partial re-check of an unchanged file never does.
 */
export interface TopicEvidence {
  coveredThrough: number
  lines: number
  bytes: number
}
export type ReadEvidence = Map<string, TopicEvidence>

export class TopicTools {
  constructor(
    private readonly store: MemoryStore,
    private readonly evidence: ReadEvidence,
    private readonly tunables: () => TopicTunables,
    private readonly securityScan: () => boolean,
  ) {}

  /** Execute one validated call; throws HarnessError on any failure. */
  async execute(rawArgs: TopicToolArgs): Promise<TopicValue> {
    const tunables = this.tunables()
    if (!tunables.topicsEnabled) {
      throw new HarnessError(
        'Topic files are disabled in this configuration (topicsEnabled: false). '
        + 'Keep detail inside single-line memory entries.',
        'MEMORY_TOPIC_DISABLED',
      )
    }
    const call = validateTopicArgs(rawArgs)
    switch (call.action) {
      case 'topic_list':
        return this.list()
      case 'topic_read':
        return this.read(call.name!, tunables, call.offset, call.limit)
      case 'topic_write':
        return this.write(call.name!, call.content!)
      case 'topic_append':
        return this.append(call.name!, call.content!)
      case 'topic_remove':
        return this.remove(call.name!)
    }
  }

  private async list(): Promise<TopicValue> {
    const topics = await this.store.listTopics()
    const snapshots = this.store.readAllSync()
    const indexText = [...snapshots.memory.entries, ...snapshots.user.entries].join('\n')
    return {
      action: 'topic_list',
      topics: topics.map((topic): TopicListEntry => ({
        name: topic.name,
        bytes: topic.bytes,
        orphan: !isReferenced(topic.name, indexText),
      })),
    }
  }

  private async read(name: string, tunables: TopicTunables, offset?: number, limit?: number): Promise<TopicValue> {
    const text = await this.store.readTopic(name)
    const all = text.split('\n')
    const start = (offset ?? 1) - 1
    // The configured window is both the default and the maximum page size.
    const maxLines = Math.min(limit ?? tunables.topicReadLines, tunables.topicReadLines)
    const selected: string[] = []
    let bytes = 0
    let byteCut = false
    for (const line of all.slice(start, start + maxLines)) {
      const lineBytes = Buffer.byteLength(line, 'utf8')
      if (selected.length > 0 && bytes + lineBytes > tunables.topicReadMaxBytes) {
        byteCut = true
        break
      }
      if (selected.length === 0 && lineBytes > tunables.topicReadMaxBytes) {
        // One over-long line: hard-truncate rather than return nothing.
        selected.push(`${Buffer.from(line, 'utf8').subarray(0, tunables.topicReadMaxBytes).toString('utf8')}…`)
        byteCut = true
        break
      }
      selected.push(line)
      bytes += lineBytes
    }
    const covered = start + selected.length
    const truncated = byteCut || covered < all.length
    // Contiguous coverage only, and only within ONE version: a read starting
    // past the covered prefix leaves a gap, and a file whose size changed
    // between pages (rewritten mid-paging by another context) resets the
    // frontier — otherwise pages from different versions would stitch into
    // a false complete.
    const prior = this.evidence.get(name)
    const textBytes = Buffer.byteLength(text, 'utf8')
    let coveredThrough = prior !== undefined && prior.bytes === textBytes ? prior.coveredThrough : 0
    if (start <= coveredThrough) coveredThrough = Math.max(coveredThrough, covered)
    this.evidence.set(name, { coveredThrough, lines: all.length, bytes: textBytes })
    return {
      action: 'topic_read',
      name,
      lines: selected,
      totalLines: all.length,
      offset: start + 1,
      bytes,
      ...truncated ? { truncated: true } : {},
    }
  }

  /** Current on-disk state for gate decisions; undefined = does not exist. */
  private async currentState(name: string): Promise<{ bytes: number; lines: number } | undefined> {
    const size = await this.store.topicSize(name)
    if (size === undefined) return undefined
    const text = await this.store.readTopic(name)
    return { bytes: Buffer.byteLength(text, 'utf8'), lines: text.split('\n').length }
  }

  /**
   * Gate destructive actions on FULL, FRESH knowledge: the file's current
   * content must be covered by contiguous reads made against its current
   * size. Append is non-destructive — any prior look suffices. Creating
   * destroys nothing and is always allowed.
   */
  private requireEvidence(
    name: string,
    current: { bytes: number; lines: number } | undefined,
    destructive: 'overwrite' | 'append' | 'remove',
  ): void {
    if (current === undefined) return
    const record = this.evidence.get(name)
    if (record === undefined) {
      throw new HarnessError(
        `read-before-write: topic_read "${name}" first — no altering content you have not seen.`,
        'MEMORY_TOPIC_UNREAD',
      )
    }
    if (destructive === 'append') return
    if (record.bytes !== current.bytes) {
      throw new HarnessError(
        `"${name}" changed since you last read it (a background review may have appended). `
        + 'topic_read it again before overwriting or deleting — otherwise content you never '
        + 'saw would be destroyed without entering the transcript.',
        'MEMORY_TOPIC_STALE_READ',
      )
    }
    if (record.coveredThrough < current.lines) {
      throw new HarnessError(
        `You have only read part of "${name}" (the read was truncated). Finish reading it `
        + '(topic_read with offset=N) before overwriting or deleting it — otherwise the '
        + 'unread part would be destroyed without ever entering the transcript.',
        'MEMORY_TOPIC_PARTIALLY_READ',
      )
    }
  }

  private scanWrite(content: string): void {
    if (!this.securityScan()) return
    const hit = scanBulk(content)
    if (hit !== undefined) throw scanBulkRejectedError(hit.ruleId)
  }

  private async write(name: string, content: string): Promise<TopicValue> {
    this.requireEvidence(name, await this.currentState(name), 'overwrite')
    this.scanWrite(content)
    const info: TopicInfo = await this.store.writeTopic(name, content)
    // A write means the whole current content is self-produced: full knowledge.
    this.evidence.set(name, { coveredThrough: info.lines!, lines: info.lines!, bytes: info.bytes })
    return { action: 'topic_write', name, bytes: info.bytes, cap: this.store.topicCaps().maxBytes }
  }

  private async append(name: string, content: string): Promise<TopicValue> {
    const current = await this.currentState(name)
    this.requireEvidence(name, current, 'append')
    this.scanWrite(content)
    const info = await this.store.appendTopic(name, content)
    // Appending to a file whose full current content was known extends full
    // knowledge (the model knows what it appended); otherwise the coverage
    // frontier stays put and freshness simply refreshes. An append-created
    // file starts UNKNOWN (strict but safe): only its tail is self-produced.
    const prior = this.evidence.get(name)
    const wasComplete = prior !== undefined && current !== undefined
      && prior.bytes === current.bytes && prior.coveredThrough >= current.lines
    if (prior === undefined) {
      this.evidence.set(name, { coveredThrough: 0, lines: info.lines!, bytes: info.bytes })
    } else {
      this.evidence.set(name, {
        coveredThrough: wasComplete ? info.lines! : prior.coveredThrough,
        lines: info.lines!,
        bytes: info.bytes,
      })
    }
    return { action: 'topic_append', name, bytes: info.bytes, cap: this.store.topicCaps().maxBytes }
  }

  private async remove(name: string): Promise<TopicValue> {
    this.requireEvidence(name, await this.currentState(name), 'remove')
    await this.store.removeTopic(name)
    this.evidence.delete(name)
    return { action: 'topic_remove', name }
  }
}

/** Render one canonical value to the model-facing text (pure). */
export function renderTopicValue(value: TopicValue): string {
  switch (value.action) {
    case 'topic_list': {
      const topics = value.topics ?? []
      if (topics.length === 0) return '(no topic files yet)'
      return topics
        .map(t => `- ${t.name} (${formatKib(t.bytes)})${t.orphan ? ' [orphan — no index entry references it]' : ''}`)
        .join('\n')
    }
    case 'topic_read': {
      const body = (value.lines ?? []).join('\n')
      const hint = value.truncated === true
        ? `\n…truncated (${(value.lines ?? []).length}/${value.totalLines} lines shown); continue with offset=${(value.offset ?? 1) + (value.lines ?? []).length}.`
        : ''
      return `topics/${value.name}.md:\n${body}${hint}`
    }
    case 'topic_write':
      return `Saved. topics/${value.name}.md is now ${formatKib(value.bytes ?? 0)} (cap ${formatKib(value.cap ?? 0)}).`
    case 'topic_append':
      return `Appended. topics/${value.name}.md is now ${formatKib(value.bytes ?? 0)} (cap ${formatKib(value.cap ?? 0)}).`
    case 'topic_remove':
      return `Deleted topics/${value.name}.md.`
  }
}

const ACTION_TITLES: Readonly<Record<TopicAction, string>> = {
  topic_list: 'List topic files',
  topic_read: 'Read topic file',
  topic_write: 'Write topic file',
  topic_append: 'Append to topic file',
  topic_remove: 'Remove topic file',
}

/**
 * Plain-JSON-schema declaration for the background review fork, in the
 * same shape as forkSkillToolSchemas(). The fork normally inherits the
 * tool from header.tools, but sessions created before the tool existed
 * (e.g. across a hot-reload) lack it — the review appends this schema
 * itself, deduped by name.
 */
export function forkTopicToolSchema(): unknown {
  return {
    name: TOPIC_TOOL_NAME,
    description:
      'Manage topic files — the detail layer behind one-line memory index entries. '
      + 'Write detail with topic_write / topic_append (topics/<name>.md, kebab-case name); '
      + 'read with topic_read (bounded window, 1-based offset to continue); '
      + 'topic_list lists all. Overwriting or removing requires a COMPLETE read first; '
      + 'appending requires any prior read; creating needs none.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...TOPIC_ACTIONS] },
        name: { type: 'string', description: 'Topic name, kebab-case (topics/<name>.md). Not for topic_list.' },
        content: { type: 'string', description: 'Full content (topic_write) or text to append (topic_append).' },
        offset: { type: 'integer', description: 'topic_read: 1-based first line (default 1).' },
        limit: { type: 'integer', description: 'topic_read: max lines (default/max the read window).' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  }
}

/** Options for defineTool(); exported un-compiled so tests can drive execute(). */
export function buildTopicTool(deps: {
  readonly store: MemoryStore
  readonly tunables: () => TopicTunables
  readonly securityScan: () => boolean
}) {
  // Read-before-write evidence per session; the fallback map serves
  // agent-less direct execute() calls (diagnostics, tests) — deliberately
  // not fail-closed.
  const byAgent = new WeakMap<Agent, ReadEvidence>()
  const fallback: ReadEvidence = new Map()
  const evidenceFor = (agent: Agent | undefined): ReadEvidence => {
    if (agent === undefined) return fallback
    let map = byAgent.get(agent)
    if (map === undefined) {
      map = new Map()
      byAgent.set(agent, map)
    }
    return map
  }
  return {
    name: TOPIC_TOOL_NAME,
    description:
      'Manage topic files — the detail layer behind your one-line memory index entries. '
      + 'When a fact needs more than one line (commands, examples, a debugging narrative), '
      + 'write the detail to topics/<name>.md with topic_write / topic_append and keep the '
      + 'index entry to one line ending in `→ topics/<name>.md`. Topic files are NOT in your '
      + 'system prompt: read them on demand with topic_read (bounded window; use offset to '
      + 'continue). Overwriting or removing a topic you have not fully read is refused.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: [...TOPIC_ACTIONS],
        description: 'topic_list / topic_read / topic_write / topic_append / topic_remove.',
      },
      name: {
        type: 'string',
        description: 'Topic name, kebab-case (the file is topics/<name>.md). Required for all actions except topic_list.',
      },
      content: {
        type: 'string',
        description: 'Full new content (topic_write) or the text to append (topic_append). May span multiple lines.',
      },
      offset: {
        type: 'integer',
        description: 'topic_read only: 1-based first line to return. Defaults to 1.',
      },
      limit: {
        type: 'integer',
        description: 'topic_read only: maximum lines to return. Defaults to the configured read window.',
      },
    } as const,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, enum: [...TOPIC_ACTIONS] },
          name: { type: 'string' },
          bytes: { type: 'integer' },
          cap: { type: 'integer' },
          lines: { type: 'array', items: { type: 'string' } },
          totalLines: { type: 'integer' },
          offset: { type: 'integer' },
          truncated: { type: 'boolean' },
          topics: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                bytes: { type: 'integer', required: true },
                orphan: { type: 'boolean', required: true },
              },
            },
          },
        },
      } as const,
      render: (_args: unknown, value: TopicValue) => [{ type: 'text' as const, text: renderTopicValue(value) }],
    },
    async execute(args: TopicToolArgs, exec: { agent?: Agent }): Promise<TopicValue> {
      const tools = new TopicTools(deps.store, evidenceFor(exec.agent), deps.tunables, deps.securityScan)
      return tools.execute(args)
    },
    presentCall(args: TopicToolArgs) {
      const action = (TOPIC_ACTIONS as readonly string[]).includes(args.action ?? '')
        ? (args.action as TopicAction)
        : 'topic_write'
      return {
        card: 'generic' as const,
        kind: 'edit' as const,
        title: `${ACTION_TITLES[action]}${args.name ? ` (${args.name})` : ''}`,
        rawInput: args.name ?? '',
      }
    },
  }
}
