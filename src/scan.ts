/**
 * Heuristic security scan for memory content. Entries end up inside future
 * system prompts, so instruction-shaped, invisible-character, and
 * exfiltration-shaped content is refused. This is a denylist of known bad
 * shapes, NOT a complete defense — the real boundary is that the memory
 * files are the user's own local, hand-inspectable text.
 *
 * Applied twice with the same rules: on tool writes (front door) and when
 * rendering the prompt snapshot (side door, catching hand-edited files).
 *
 * The invisible-character classes are built from numeric codepoints so this
 * source file never itself contains the characters it rejects.
 */

export interface ScanHit {
  readonly ruleId: string
}

interface ScanRule {
  readonly ruleId: string
  readonly pattern: RegExp
}

type CodeItem = number | readonly [number, number]

/** Build a character class from codepoints; keeps this file ASCII-only. */
function invisibleClass(items: readonly CodeItem[]): RegExp {
  const parts = items.map((item) => {
    if (typeof item === 'number') return String.fromCodePoint(item)
    return `${String.fromCodePoint(item[0])}-${String.fromCodePoint(item[1])}`
  })
  return new RegExp(`[${parts.join('')}]`, 'u')
}

/**
 * Shown in place of a scan-flagged entry, both in the prompt snapshot and
 * in error payloads that list current entries — the two channels into the
 * model must apply the same masking.
 */
export const HIDDEN_ENTRY_PLACEHOLDER = '(1 entry hidden by the security scan — inspect the file by hand)'

/**
 * Every Unicode line-break codepoint (LF/VT/FF/CR, NEL, LS/PS). The tool's
 * single-line rule tests against this even when the security scan is off —
 * the scan's control/line-sep rules cover these five beyond \r\n, but that
 * coverage disappears with `securityScan: false`.
 */
export const lineBreakClass: RegExp = invisibleClass([[0x000a, 0x000d], 0x0085, [0x2028, 0x2029]])

/**
 * Data-driven rule table; add or remove a row to tune. Deliberately does
 * NOT flag the phrase "system prompt" itself — it is a legitimate,
 * high-frequency term in harness-research notes; only imperative
 * override/rewrite shapes are matched.
 */
const RULES: readonly ScanRule[] = [
  // -- A. invisible / control characters ---------------------------------
  // C0/C1 controls, including tab and newlines: entries are single-line
  // trimmed text and never legitimately contain them.
  { ruleId: 'invisible.control', pattern: invisibleClass([[0x0000, 0x001F], [0x007F, 0x009F]]) },
  // Zero-width family + LRM/RLM + word joiner + invisible operators + BOM.
  // Known false positives (accepted, documented): ZWJ emoji sequences and
  // ZWNJ-using scripts. Variation selectors VS15/VS16 stay allowed — they
  // are how ordinary emoji render.
  { ruleId: 'invisible.zero-width', pattern: invisibleClass([[0x200B, 0x200F], [0x2060, 0x2064], 0xFEFF]) },
  // Bidirectional overrides/isolates (Trojan-Source shapes).
  { ruleId: 'invisible.bidi', pattern: invisibleClass([[0x202A, 0x202E], [0x2066, 0x2069]]) },
  // Unicode line/paragraph separators would smuggle line breaks past the
  // single-line rule.
  { ruleId: 'invisible.line-sep', pattern: invisibleClass([0x2028, 0x2029]) },
  // Tag characters: invisible ASCII smuggling channel.
  { ruleId: 'invisible.tags', pattern: invisibleClass([[0xE0000, 0xE007F]]) },

  // -- B. injection / exfiltration heuristics ----------------------------
  { ruleId: 'injection.override', pattern: /\b(?:ignore|disregard|forget)\b.{0,30}\b(?:previous|prior|earlier|above|all)\b.{0,30}\b(?:instructions?|messages?|context|rules?)\b/is },
  { ruleId: 'injection.new-instructions', pattern: /\bnew\s+(?:system\s+|developer\s+)?instructions?\s*[:：]/i },
  { ruleId: 'injection.persona-hijack', pattern: /\byou\s+are\s+now\b|\byour\s+new\s+(?:role|persona|instructions?)\b/i },
  { ruleId: 'injection.role-tags', pattern: /<\s*\/?\s*(?:system|assistant|tool)\b|<\|\s*(?:im_start|im_end|system)\b/i },
  { ruleId: 'exfil.send-url', pattern: /\b(?:send|post|upload|forward|exfiltrate|transmit)\b.{0,60}https?:\/\//is },
  // Markdown image with a remote URL: classic zero-click exfil channel.
  { ruleId: 'exfil.md-image', pattern: /!\[[^\]]*\]\(\s*https?:\/\//i },
]

/** Returns the first matching rule, or undefined when the text is clean. */
export function scan(text: string): ScanHit | undefined {
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return { ruleId: rule.ruleId }
  }
  return undefined
}
