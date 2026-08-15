import { describe, expect, it } from 'vitest'
import { codepoints, matchEntries, normalizeOp, parseEntries, serializeEntries } from '../src/entries.js'

// NFD sample built from codepoints: source files must never contain literal
// combining characters (generation-layer pitfall).
const NFD = `cafe${String.fromCodePoint(0x0301)}`
const NFC = NFD.normalize('NFC')

describe('codepoints', () => {
  it('counts ASCII and empty text', () => {
    expect(codepoints('')).toBe(0)
    expect(codepoints('abc')).toBe(3)
  })

  it('counts CJK one per character', () => {
    expect(codepoints('记忆系统')).toBe(4)
  })

  it('counts an astral emoji as one codepoint, not two UTF-16 units', () => {
    const thumbsUp = String.fromCodePoint(0x1F44D)
    expect(thumbsUp.length).toBe(2)
    expect(codepoints(thumbsUp)).toBe(1)
  })
})

describe('parseEntries', () => {
  it('parses normalized bullet lines', () => {
    expect(parseEntries('- alpha\n- beta\n')).toEqual(['alpha', 'beta'])
  })

  it('accepts hand-written lines without the bullet prefix', () => {
    expect(parseEntries('alpha\nbeta')).toEqual(['alpha', 'beta'])
  })

  it('skips blank lines and trims padding', () => {
    expect(parseEntries('\n  - alpha  \n\n   beta\t\n\n')).toEqual(['alpha', 'beta'])
  })

  it('handles CRLF files', () => {
    expect(parseEntries('- alpha\r\n- beta\r\n')).toEqual(['alpha', 'beta'])
  })

  it('keeps a leading dash that is not a bullet prefix', () => {
    expect(parseEntries('-alpha')).toEqual(['-alpha'])
  })

  it('returns [] for empty input', () => {
    expect(parseEntries('')).toEqual([])
  })

  it('NFC-normalizes hand-edited NFD text on the way in', () => {
    expect(NFC).not.toBe(NFD) // sanity: the two forms really differ
    expect(parseEntries(`- ${NFD}\n`)).toEqual([NFC])
  })
})

describe('serializeEntries', () => {
  it('emits one bullet line per entry', () => {
    expect(serializeEntries(['alpha', 'beta'])).toBe('- alpha\n- beta\n')
  })

  it('emits empty string for no entries', () => {
    expect(serializeEntries([])).toBe('')
  })

  it('round-trips with parseEntries', () => {
    const entries = ['alpha', '用户偏好中文', 'beta gamma']
    expect(parseEntries(serializeEntries(entries))).toEqual(entries)
  })
})

describe('matchEntries', () => {
  const entries = ['prefers concise replies', 'project uses pnpm', 'Prefers dark mode']

  it('finds a unique substring match with its index', () => {
    expect(matchEntries(entries, 'pnpm')).toEqual({ kind: 'one', index: 1 })
  })

  it('matches anywhere inside the entry', () => {
    expect(matchEntries(entries, 'concise')).toEqual({ kind: 'one', index: 0 })
  })

  it('is case-sensitive', () => {
    // 'prefers' (lowercase) hits only entry 0; 'Prefers' only entry 2.
    expect(matchEntries(entries, 'prefers')).toEqual({ kind: 'one', index: 0 })
    expect(matchEntries(entries, 'Prefers')).toEqual({ kind: 'one', index: 2 })
  })

  it('reports zero matches', () => {
    expect(matchEntries(entries, 'nonexistent')).toEqual({ kind: 'none' })
  })

  it('reports all ambiguous match indexes', () => {
    expect(matchEntries(entries, 'e')).toEqual({ kind: 'many', indexes: [0, 1, 2] })
  })

  it('an exact full-text match wins when one entry is a substring of another', () => {
    const nested = ['port 7788', 'old port 7788 is legacy']
    // every substring of entry 0 also hits entry 1 — only the exact
    // short-circuit can single it out
    expect(matchEntries(nested, 'port 7788')).toEqual({ kind: 'one', index: 0 })
    expect(matchEntries(nested, '7788')).toEqual({ kind: 'many', indexes: [0, 1] })
  })

  it('duplicate entries stay ambiguous even for an exact target', () => {
    expect(matchEntries(['dup', 'dup'], 'dup')).toEqual({ kind: 'many', indexes: [0, 1] })
  })
})

describe('normalizeOp', () => {
  it('NFC-normalizes every text field per action', () => {
    expect(normalizeOp({ action: 'add', content: NFD })).toEqual({ action: 'add', content: NFC })
    expect(normalizeOp({ action: 'replace', target: NFD, newContent: NFD }))
      .toEqual({ action: 'replace', target: NFC, newContent: NFC })
    expect(normalizeOp({ action: 'remove', target: NFD })).toEqual({ action: 'remove', target: NFC })
  })
})
