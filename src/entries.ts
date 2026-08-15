/**
 * Pure entry-list logic for the bounded memory files: lenient parsing,
 * normalized serialization, unique-substring matching, and codepoint
 * counting. No I/O and no dsh imports; everything here is unit-testable
 * in isolation.
 */

/**
 * Count Unicode codepoints rather than UTF-16 code units, matching the
 * intuition of Hermes' Python `len()` (emoji surrogate pairs count as 1;
 * CJK is identical under both counts).
 */
export function codepoints(text: string): number {
  let count = 0
  for (const _ of text) count++
  return count
}

/**
 * Parse a memory file leniently: one entry per non-blank line; the `- `
 * bullet prefix is optional so hand edits without it still count. Entries
 * are NFC-normalized on the way in, so hand-edited NFD text still matches
 * NFC tool targets.
 */
export function parseEntries(raw: string): string[] {
  const entries: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const content = trimmed.startsWith('- ') ? trimmed.slice(2).trim() : trimmed
    entries.push(content.normalize('NFC'))
  }
  return entries
}

/** Serialize in normalized form: `- ${content}\n` per entry; '' when empty. */
export function serializeEntries(entries: readonly string[]): string {
  return entries.map(entry => `- ${entry}\n`).join('')
}

export type MemoryAction = 'add' | 'replace' | 'remove'

/**
 * A validated mutation against one memory file. A discriminated union so
 * each action can only carry (and must carry) its own fields — a partial
 * op cannot reach the store and silently serialize "undefined".
 */
export type MemoryOp =
  | { readonly action: 'add'; readonly content: string }
  | { readonly action: 'replace'; readonly target: string; readonly newContent: string }
  | { readonly action: 'remove'; readonly target: string }

/**
 * NFC-normalize every text field of an op, so matching, limit counting,
 * and on-disk bytes all agree on one canonical form.
 */
export function normalizeOp(op: MemoryOp): MemoryOp {
  switch (op.action) {
    case 'add':
      return { action: 'add', content: op.content.normalize('NFC') }
    case 'replace':
      return { action: 'replace', target: op.target.normalize('NFC'), newContent: op.newContent.normalize('NFC') }
    case 'remove':
      return { action: 'remove', target: op.target.normalize('NFC') }
  }
}

export type MatchResult =
  | { readonly kind: 'one'; readonly index: number }
  | { readonly kind: 'none' }
  | { readonly kind: 'many'; readonly indexes: readonly number[] }

/**
 * Case-sensitive substring match over entry contents. A target equal to
 * exactly one entry's full text wins outright: when entry A is a substring
 * of entry B, every substring of A also hits B, so without this short
 * circuit A could never be singled out at all.
 */
export function matchEntries(entries: readonly string[], target: string): MatchResult {
  const exact: number[] = []
  const indexes: number[] = []
  entries.forEach((entry, index) => {
    if (entry === target) exact.push(index)
    if (entry.includes(target)) indexes.push(index)
  })
  if (exact.length === 1) return { kind: 'one', index: exact[0]! }
  if (indexes.length === 1) return { kind: 'one', index: indexes[0]! }
  if (indexes.length === 0) return { kind: 'none' }
  return { kind: 'many', indexes }
}
