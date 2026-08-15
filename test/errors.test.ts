import { HarnessError } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import type { FileState } from '../src/errors.js'
import {
  approvalCancelledError,
  approvalRejectedError,
  approvalUnavailableError,
  entryTooLargeError,
  invalidArgumentsError,
  lockBusyError,
  multilineEntryError,
  overflowError,
  percentOf,
  scanRejectedError,
  targetAmbiguousError,
  targetNotFoundError,
  usageHeader,
} from '../src/errors.js'

const STATE: FileState = {
  label: 'MEMORY.md',
  limit: 2200,
  entries: ['prefers concise replies', 'project uses pnpm'],
  chars: 1474,
}

describe('usageHeader', () => {
  it('matches the Hermes format with thousands separators', () => {
    expect(usageHeader(1474, 2200)).toBe('[67% — 1,474/2,200 chars]')
  })

  it('rounds the percentage', () => {
    expect(percentOf(1, 3)).toBe(33)
    expect(percentOf(2, 3)).toBe(67)
    expect(percentOf(0, 2200)).toBe(0)
  })
})

describe('overflowError', () => {
  const error = overflowError(STATE, 2456)

  it('is a HarnessError with a stable code', () => {
    expect(error).toBeInstanceOf(HarnessError)
    expect(error.code).toBe('MEMORY_OVERFLOW')
  })

  it('carries usage, the consolidation instruction, and current entries', () => {
    expect(error.message).toContain('2,456')
    expect(error.message).toContain('[67% — 1,474/2,200 chars]')
    expect(error.message).toContain('Do NOT drop the new information')
    expect(error.message).toContain('Consolidate in this same turn')
    expect(error.message).toContain('Current entries:')
    expect(error.message).toContain('- prefers concise replies')
    expect(error.message).toContain('- project uses pnpm')
  })

  it('states emptiness instead of listing entries for an empty file', () => {
    const empty = overflowError({ ...STATE, entries: [], chars: 0 }, 2456)
    expect(empty.message).toContain('MEMORY.md is currently empty.')
    expect(empty.message).not.toContain('Current entries:')
  })

  it('uses the singular for exactly one entry', () => {
    const one = overflowError({ ...STATE, entries: ['solo fact'], chars: 12 }, 2456)
    expect(one.message).toContain('1 entry)')
  })
})

describe('entryTooLargeError', () => {
  it('says shortening, not consolidation, is the fix', () => {
    const error = entryTooLargeError('USER.md', 1375, 1500)
    expect(error.code).toBe('MEMORY_ENTRY_TOO_LARGE')
    expect(error.message).toContain('1,500')
    expect(error.message).toContain('1,375')
    expect(error.message).toContain('USER.md')
    expect(error.message).toContain('Shorten it')
  })
})

describe('targetNotFoundError', () => {
  const error = targetNotFoundError(STATE, 'missing thing')

  it('quotes the target and warns about the frozen snapshot', () => {
    expect(error.code).toBe('MEMORY_TARGET_NOT_FOUND')
    expect(error.message).toContain('"missing thing"')
    expect(error.message).toContain('case-sensitive')
    expect(error.message).toContain('frozen at session start')
  })

  it('lists the live on-disk entries as the recovery channel', () => {
    expect(error.message).toContain('Current entries:')
    expect(error.message).toContain('- project uses pnpm')
  })
})

describe('targetAmbiguousError', () => {
  it('lists exactly the matching entries', () => {
    const error = targetAmbiguousError(STATE, 'p', STATE.entries)
    expect(error.code).toBe('MEMORY_TARGET_AMBIGUOUS')
    expect(error.message).toContain('"p" matches 2 entries')
    expect(error.message).toContain('Matching entries:')
    expect(error.message).toContain('- prefers concise replies')
  })

  it('teaches the full-text-as-target escape hatch', () => {
    const error = targetAmbiguousError(STATE, 'p', STATE.entries)
    expect(error.message).toContain('pasting the full text of the entry')
  })
})

describe('lockBusyError', () => {
  it('gives conditional guidance and the lock path', () => {
    const error = lockBusyError('MEMORY.md', 'C:/home/.dsh/memory/MEMORY.md.lock')
    expect(error.code).toBe('MEMORY_LOCK_BUSY')
    expect(error.message).toContain('Another dsh process may be writing')
    expect(error.message).toContain('If you are sure no other dsh process is running')
    expect(error.message).toContain('C:/home/.dsh/memory/MEMORY.md.lock')
  })
})

describe('remaining constructors', () => {
  it('carry their codes and non-empty messages', () => {
    const cases: readonly [HarnessError, string][] = [
      [multilineEntryError(), 'MEMORY_MULTILINE_ENTRY'],
      [invalidArgumentsError('add requires content.'), 'MEMORY_INVALID_ARGS'],
      [scanRejectedError('injection.override'), 'MEMORY_SCAN_REJECTED'],
      [approvalRejectedError(), 'MEMORY_APPROVAL_REJECTED'],
      [approvalCancelledError(), 'MEMORY_APPROVAL_CANCELLED'],
      [approvalUnavailableError(), 'MEMORY_APPROVAL_UNAVAILABLE'],
    ]
    for (const [error, code] of cases) {
      expect(error).toBeInstanceOf(HarnessError)
      expect(error.code).toBe(code)
      expect(error.message.length).toBeGreaterThan(10)
    }
  })

  it('names the offending rule in scan rejections', () => {
    expect(scanRejectedError('exfil.md-image').message).toContain('exfil.md-image')
  })
})
