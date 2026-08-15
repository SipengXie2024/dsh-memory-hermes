/**
 * Skill provenance: which skills the autonomous curator may touch.
 *
 * Hermes keeps `created_by: agent` in a telemetry sidecar; we keep it in the
 * SKILL.md frontmatter instead — the marker travels with the file, dsh's own
 * skill loader parses it into metadata, and no separate ledger can race the
 * write it describes (hermes issue #67140). Policy identical to Hermes:
 * anything without the marker is user-owned and off-limits to autonomous
 * curation; an unreadable marker fails CLOSED.
 *
 * @module dsh-memory-hermes/skills/provenance
 */

/** Frontmatter marker written by skill_manage(create) inside the review fork. */
export const CURATOR_MARKER = 'agent'

export interface SkillFrontmatter {
  readonly name?: string
  readonly description?: string
  readonly createdBy?: string
}

/**
 * Minimal frontmatter reader for the three keys the curator cares about.
 * Machine-written files parse exactly; hand-written files with exotic YAML
 * simply yield no marker, which the policy treats as user-owned anyway.
 */
export function parseFrontmatter(text: string): { meta: SkillFrontmatter; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (match === null) return { meta: {}, body: text }
  const meta: { name?: string; description?: string; createdBy?: string } = {}
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line)
    if (kv === null) continue
    const value = kv[2]!.trim().replace(/^['"]|['"]$/g, '')
    if (kv[1] === 'name') meta.name = value
    else if (kv[1] === 'description') meta.description = value
    else if (kv[1] === 'created_by') meta.createdBy = value
  }
  return { meta, body: text.slice(match[0].length) }
}

/** Serialize frontmatter + body (only the keys we own; values are plain). */
export function renderSkillFile(meta: { name: string; description: string; createdBy?: string }, body: string): string {
  const lines = [
    '---',
    `name: ${meta.name}`,
    `description: ${meta.description}`,
    ...meta.createdBy === undefined ? [] : [`created_by: ${meta.createdBy}`],
    '---',
    '',
  ]
  return `${lines.join('\n')}${body.trimStart()}`
}

/** Whether the curator may mutate this skill (marker must read 'agent'). */
export function isCuratorManaged(skillFileText: string): boolean {
  return parseFrontmatter(skillFileText).meta.createdBy === CURATOR_MARKER
}

/**
 * Jurisdiction transfer, text-level: set `created_by: agent` while leaving
 * every other frontmatter line byte-identical — hand-written skills may
 * carry keys this module does not model (e.g. disable-model-invocation),
 * and a re-render through renderSkillFile would silently drop them.
 */
export function adoptSkillText(text: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (match === null) {
    return `---\ncreated_by: ${CURATOR_MARKER}\n---\n${text}`
  }
  const lines = match[1]!.split(/\r?\n/)
  const markerLine = `created_by: ${CURATOR_MARKER}`
  const hadMarker = lines.some(line => /^created_by\s*:/.test(line))
  const nextLines = hadMarker
    ? lines.map(line => (/^created_by\s*:/.test(line) ? markerLine : line))
    : [...lines, markerLine]
  return `---\n${nextLines.join('\n')}\n---\n${text.slice(match[0].length)}`
}
