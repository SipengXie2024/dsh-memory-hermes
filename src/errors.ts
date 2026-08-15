/**
 * Single home for every model-facing error message. All information the
 * model needs to recover lives in the message text: `HarnessError` codes
 * are best-effort only, because `instanceof` across duplicated package
 * copies (link: installs) silently downgrades them to plain errors.
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** On-disk truth about one memory file at error time. */
export interface FileState {
  /** Display name, e.g. `MEMORY.md`. */
  readonly label: string
  readonly limit: number
  readonly entries: readonly string[]
  /** Serialized codepoint count of the current content. */
  readonly chars: number
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

export function percentOf(chars: number, limit: number): number {
  return Math.round((chars / limit) * 100)
}

/** `[67% — 1,474/2,200 chars]`, the Hermes usage-header format. */
export function usageHeader(chars: number, limit: number): string {
  return `[${percentOf(chars, limit)}% — ${fmt(chars)}/${fmt(limit)} chars]`
}

function renderCurrentEntries(state: FileState): string {
  if (state.entries.length === 0) return `${state.label} is currently empty.`
  return `Current entries:\n${state.entries.map(entry => `- ${entry}`).join('\n')}`
}

export function overflowError(state: FileState, attemptedChars: number): HarnessError {
  return new HarnessError(
    `${state.label} is full: this write needs ${fmt(attemptedChars)} chars but the limit is `
    + `${fmt(state.limit)} (currently ${usageHeader(state.chars, state.limit)}, `
    + `${state.entries.length} ${state.entries.length === 1 ? 'entry' : 'entries'}).\n`
    + 'Do NOT drop the new information. Consolidate in this same turn: merge overlapping '
    + 'entries with replace, delete obsolete ones with remove, then retry.\n'
    + renderCurrentEntries(state),
    'MEMORY_OVERFLOW',
  )
}

/** The single entry alone exceeds the file limit; consolidation cannot help. */
export function entryTooLargeError(label: string, limit: number, attemptedChars: number): HarnessError {
  return new HarnessError(
    `This single entry is ${fmt(attemptedChars)} chars serialized (the "- " bullet and `
    + `newline add 3), above the ${fmt(limit)}-char total limit for ${label}. Shorten it to `
    + 'its essential fact, or store a pointer to where the detail lives.',
    'MEMORY_ENTRY_TOO_LARGE',
  )
}

export function targetNotFoundError(state: FileState, target: string): HarnessError {
  return new HarnessError(
    `No entry in ${state.label} contains "${target}". Matching is exact and case-sensitive, `
    + 'and the in-prompt snapshot is frozen at session start — it may be stale after earlier '
    + 'writes. Match against the current entries below.\n'
    + renderCurrentEntries(state),
    'MEMORY_TARGET_NOT_FOUND',
  )
}

export function targetAmbiguousError(state: FileState, target: string, matched: readonly string[]): HarnessError {
  return new HarnessError(
    `"${target}" matches ${matched.length} entries in ${state.label}. Provide a longer `
    + 'substring that uniquely identifies exactly one; pasting the full text of the entry '
    + 'always works, because an exact match wins over substring matches.\n'
    + `Matching entries:\n${matched.map(entry => `- ${entry}`).join('\n')}`,
    'MEMORY_TARGET_AMBIGUOUS',
  )
}

export function multilineEntryError(): HarnessError {
  return new HarnessError(
    'Memory entries are single-line. Split this into separate entries or rephrase without '
    + 'line breaks.',
    'MEMORY_MULTILINE_ENTRY',
  )
}

export function invalidArgumentsError(detail: string): HarnessError {
  return new HarnessError(`Invalid memory tool arguments: ${detail}`, 'MEMORY_INVALID_ARGS')
}

export function scanRejectedError(ruleId: string): HarnessError {
  return new HarnessError(
    `Write rejected by the memory security scan (${ruleId}). Memory entries are injected `
    + 'into future system prompts, so instruction-like, invisible-character, or '
    + 'exfiltration-shaped content is not allowed. Rephrase as a plain factual note. '
    + 'This scan is heuristic; do not try to work around it.',
    'MEMORY_SCAN_REJECTED',
  )
}

export function approvalRejectedError(): HarnessError {
  return new HarnessError('The user declined this memory write.', 'MEMORY_APPROVAL_REJECTED')
}

export function approvalCancelledError(): HarnessError {
  return new HarnessError('Memory write approval was cancelled.', 'MEMORY_APPROVAL_CANCELLED')
}

export function approvalUnavailableError(): HarnessError {
  return new HarnessError(
    'Memory writes require user approval in this configuration, but no approval channel '
    + 'is available.',
    'MEMORY_APPROVAL_UNAVAILABLE',
  )
}

/**
 * Lock acquisition timed out. Ambiguous between live contention and an
 * orphaned lock left by a killed process, so the guidance is conditional —
 * never unconditionally advise deleting a lock another process may hold.
 */
export function lockBusyError(label: string, lockPath: string): HarnessError {
  return new HarnessError(
    `Could not acquire the write lock for ${label} within 2 seconds. Another dsh process `
    + 'may be writing right now — retry shortly. If you are sure no other dsh process is '
    + `running, the lock is stale; ask the user to delete it by hand: ${lockPath}`,
    'MEMORY_LOCK_BUSY',
  )
}
