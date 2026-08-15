/**
 * The single Hermes-style `memory` tool: add / replace / remove over the
 * two bounded files. There is no read action — the content already sits in
 * the system prompt snapshot. Built as a factory returning defineTool
 * options so tests can call execute() without booting a tool registry.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MemoryAction, MemoryOp } from './entries.js'
import {
  approvalCancelledError,
  approvalRejectedError,
  approvalUnavailableError,
  invalidArgumentsError,
  multilineEntryError,
  scanRejectedError,
  usageHeader,
} from './errors.js'
import { lineBreakClass, scan } from './scan.js'
import type { MemoryFileKey, MemoryStore, MutateResult } from './store.js'

export const TOOL_NAME = 'memory'

const DESCRIPTION =
  'Manage your two persistent memory files, MEMORY.md (agent notes) and USER.md (user '
  + 'profile). Their content is already in your system prompt as a snapshot frozen at '
  + 'session start, so there is no read action. Writes persist to disk immediately: tool '
  + 'results show the live state, while the in-prompt snapshot only refreshes in future '
  + 'sessions. replace and remove locate one existing entry by a unique substring (target). '
  + 'Entries are single lines; capacity is small and bounded — on an overflow error, '
  + 'consolidate the listed entries in this same turn and retry without dropping the new '
  + 'information.'

/** Structural view of the optional dsh approval seam (`ctx.get('approval')`). */
export interface ApprovalLike {
  request(request: {
    agent: Agent
    toolName: string
    callId?: string
    reason?: string
    signal?: AbortSignal
  }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
}

export interface MemoryToolDeps {
  readonly store: MemoryStore
  readonly securityScan: boolean
  readonly approval: boolean
  readonly getApproval: () => ApprovalLike | undefined
}

interface MemoryToolArgs {
  readonly action: string
  readonly file: string
  readonly content?: string
  readonly target?: string
  readonly new_content?: string
}

interface ValidatedCall {
  readonly file: MemoryFileKey
  readonly op: MemoryOp
}

/**
 * Whether optional text is present at all (strict-schema '' counts as
 * absent). typeof-based so that a null smuggled past the compiled schema
 * (direct execute() calls) fails validation instead of crashing .trim().
 */
function present(value: string | undefined): value is string {
  return typeof value === 'string' && value !== ''
}

/** Whether required text carries actual content. */
function meaningful(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function requireSingleLine(text: string): void {
  // All Unicode line breaks, not just \r\n — the scan also catches the
  // exotic five, but this rule must hold with securityScan off too.
  if (lineBreakClass.test(text)) throw multilineEntryError()
}

function validate(args: MemoryToolArgs): ValidatedCall {
  // Mirrors the compiled-schema enum checks so direct execute() calls fail
  // safe too; `action` gets the same treatment via the switch default.
  if (args.file !== 'memory' && args.file !== 'user') {
    throw invalidArgumentsError(`unknown file "${String(args.file)}".`)
  }
  const file: MemoryFileKey = args.file
  const action = args.action as MemoryAction
  switch (action) {
    case 'add': {
      if (!meaningful(args.content)) throw invalidArgumentsError('add requires non-empty content.')
      if (present(args.target) || present(args.new_content)) {
        throw invalidArgumentsError('add takes only content — no target or new_content.')
      }
      requireSingleLine(args.content)
      return { file, op: { action, content: args.content.trim() } }
    }
    case 'replace': {
      if (!present(args.target) || !meaningful(args.new_content)) {
        throw invalidArgumentsError('replace requires target and non-empty new_content.')
      }
      if (present(args.content)) {
        throw invalidArgumentsError('replace takes target and new_content — no content.')
      }
      requireSingleLine(args.new_content)
      return { file, op: { action, target: args.target, newContent: args.new_content.trim() } }
    }
    case 'remove': {
      if (!present(args.target)) throw invalidArgumentsError('remove requires target.')
      if (present(args.content) || present(args.new_content)) {
        throw invalidArgumentsError('remove takes only target.')
      }
      return { file, op: { action, target: args.target } }
    }
    default:
      throw invalidArgumentsError(`unknown action "${String(args.action)}".`)
  }
}

function fileLabel(file: MemoryFileKey): string {
  return file === 'user' ? 'USER.md' : 'MEMORY.md'
}

function truncate(text: string, max: number): string {
  return [...text].length <= max ? text : `${[...text].slice(0, max).join('')}...`
}

/** The text a write introduces (undefined for remove). */
function writtenText(op: MemoryOp): string | undefined {
  switch (op.action) {
    case 'add':
      return op.content
    case 'replace':
      return op.newContent
    case 'remove':
      return undefined
  }
}

function approvalReason(call: ValidatedCall): string {
  const subject = writtenText(call.op) ?? (call.op.action === 'remove' ? call.op.target : '')
  return `memory ${call.op.action} in ${fileLabel(call.file)}: "${truncate(subject, 120)}"`
}

const TITLES: Readonly<Record<MemoryAction, string>> = {
  add: 'Add memory entry',
  replace: 'Replace memory entry',
  remove: 'Remove memory entry',
}

/** Options for defineTool(); exported un-compiled so tests can drive execute(). */
export function buildMemoryTool(deps: MemoryToolDeps) {
  return {
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['add', 'replace', 'remove'],
        description: 'add appends a new entry; replace rewrites one existing entry; remove deletes one.',
      },
      file: {
        type: 'string',
        required: true,
        enum: ['memory', 'user'],
        description: "Target store: 'memory' = MEMORY.md (agent notes: environment facts, conventions, pitfalls); 'user' = USER.md (user profile: preferences, communication style, constraints).",
      },
      content: {
        type: 'string',
        description: 'New entry text. Required for add. One terse line; no line breaks.',
      },
      target: {
        type: 'string',
        description: 'Substring uniquely identifying one existing entry. Required for replace and remove. Case-sensitive.',
      },
      new_content: {
        type: 'string',
        description: 'Replacement entry text. Required for replace. One terse line.',
      },
    } as const,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string', required: true, enum: ['memory', 'user'] },
          action: { type: 'string', required: true, enum: ['add', 'replace', 'remove'] },
          entries: { type: 'integer', required: true },
          chars: { type: 'integer', required: true },
          limit: { type: 'integer', required: true },
          percent: { type: 'integer', required: true },
        },
      } as const,
      render: (_args: unknown, value: MutateResult) => [{
        type: 'text' as const,
        text: `Saved. ${fileLabel(value.file)} is now ${usageHeader(value.chars, value.limit)}, `
          + `${value.entries} ${value.entries === 1 ? 'entry' : 'entries'}.`,
      }],
    },
    async execute(args: MemoryToolArgs, exec: { agent?: Agent; callId?: string; signal?: AbortSignal }): Promise<MutateResult> {
      const call = validate(args)
      const written = writtenText(call.op)
      if (deps.securityScan && written !== undefined) {
        const hit = scan(written)
        if (hit !== undefined) throw scanRejectedError(hit.ruleId)
      }
      if (deps.approval) {
        // Scan runs first: never ask a human to bless content the scan rejects.
        const approval = deps.getApproval()
        if (approval === undefined || exec.agent === undefined) throw approvalUnavailableError()
        let outcome: Awaited<ReturnType<ApprovalLike['request']>>
        try {
          outcome = await approval.request({
            agent: exec.agent,
            toolName: TOOL_NAME,
            ...exec.callId === undefined ? {} : { callId: exec.callId },
            reason: approvalReason(call),
            ...exec.signal === undefined ? {} : { signal: exec.signal },
          })
        } catch {
          // request() throws bare Errors on internal audit failures; fail
          // closed without leaking dsh internals into the model-facing text.
          throw approvalUnavailableError()
        }
        switch (outcome) {
          case 'allowed-once':
            break
          case 'rejected':
            throw approvalRejectedError()
          case 'cancelled':
            throw approvalCancelledError()
          case 'unavailable':
            throw approvalUnavailableError()
        }
      }
      return deps.store.mutate(call.file, call.op)
    },
    presentCall(args: MemoryToolArgs) {
      const action = (args.action in TITLES ? args.action : 'add') as MemoryAction
      return {
        card: 'generic' as const,
        kind: 'edit' as const,
        title: `${TITLES[action]} (${fileLabel(args.file as MemoryFileKey)})`,
        rawInput: (action === 'add' ? args.content : args.target) ?? '',
      }
    },
  }
}
