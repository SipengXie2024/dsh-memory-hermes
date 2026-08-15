/**
 * The review fork's skill tool surface: `skills_list` (L0 catalog),
 * `skill_view` (L1 body / L2 support file), and `skill_manage` (Hermes' six
 * actions). These live ONLY inside the review loop — they are appended to
 * the fork's tool list and dispatched by name; foreground sessions read
 * skills through dsh's native `skill` tool and write them with plain file
 * tools (which produces unmarked, hence protected, user-owned skills).
 *
 * Guardrails, 1:1 with Hermes:
 * - provenance: mutations of skills without the `created_by: agent` marker
 *   are refused (in store.ts, fail-closed);
 * - read-before-write: the fork may only mutate a target it has actually
 *   viewed this run (edit/patch/delete need the exact target; write_file /
 *   remove_file need the skill's SKILL.md), so it can never patch content it
 *   merely inferred from the transcript.
 *
 * @module dsh-memory-hermes/skills/tools
 */

import type { CuratorSkillStore } from './store.js'

export const SKILL_TOOL_NAMES = ['skills_list', 'skill_view', 'skill_manage'] as const

/** Tool schemas appended to the fork's request (plain ToolSchema shape). */
export function forkSkillToolSchemas(): readonly unknown[] {
  return [
    {
      name: 'skills_list',
      description: 'List the skill library: name and one-line description per skill (L0 discovery, no bodies).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'skill_view',
      description: 'Load one skill: its SKILL.md (L1), or one support file when path is given (L2, e.g. "references/topic.md"). You may only patch or edit targets you have viewed in this review.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name (kebab-case).' },
          path: { type: 'string', description: 'Optional support-file path inside the skill.' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
    {
      name: 'skill_manage',
      description: 'Create or evolve skills. Actions: create (new skill; name, description, content), edit (full SKILL.md rewrite; name, content[, description]), patch (find-and-replace; name, find, replace[, file_path]), delete (name), write_file (name, file_path under references/|templates/|scripts/|assets/, content), remove_file (name, file_path). Only curator-managed skills (created_by: agent) can be mutated, and only after viewing the target.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'edit', 'patch', 'delete', 'write_file', 'remove_file'] },
          name: { type: 'string', description: 'Skill name (kebab-case).' },
          description: { type: 'string', description: 'One-line routing description (create/edit).' },
          content: { type: 'string', description: 'Body text (create/edit) or file content (write_file).' },
          find: { type: 'string', description: 'Exact text to find (patch).' },
          replace: { type: 'string', description: 'Replacement text (patch).' },
          file_path: { type: 'string', description: 'Support-file path (patch/write_file/remove_file).' },
        },
        required: ['action', 'name'],
        additionalProperties: false,
      },
    },
  ]
}

/** Per-run tally of skill mutations, for the activity sidecar. */
export interface SkillActionCounts {
  created: number
  updated: number
  patched: number
  deleted: number
  filesWritten: number
  filesRemoved: number
  /** Names of skills this run created or mutated, in first-touch order. */
  skills: string[]
}

interface ManageArgs {
  action?: string
  name?: string
  description?: string
  content?: string
  find?: string
  replace?: string
  file_path?: string
}

/** Lifecycle callbacks the owner hangs on mutating actions (telemetry).
 * Fired after the store operation succeeded; failures inside a hook are the
 * hook's own problem (callers pass fire-and-forget wrappers). */
export interface SkillMutationHooks {
  onCreate?(name: string): void
  onDelete?(name: string): void
}

export class ForkSkillTools {
  readonly counts: SkillActionCounts = {
    created: 0,
    updated: 0,
    patched: 0,
    deleted: 0,
    filesWritten: 0,
    filesRemoved: 0,
    skills: [],
  }

  /** Targets this run has viewed (read-before-write evidence). */
  private readonly readPaths = new Set<string>()

  constructor(
    private readonly store: CuratorSkillStore,
    private readonly hooks: SkillMutationHooks = {},
  ) {}

  /** Execute one fork tool call; the reply text becomes the tool result. */
  async execute(toolName: string, argsJson: string): Promise<{ text: string; isError: boolean }> {
    try {
      let args: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(argsJson)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
        args = parsed as Record<string, unknown>
      } catch {
        return { text: 'invalid tool arguments: expected a JSON object', isError: true }
      }
      switch (toolName) {
        case 'skills_list':
          return await this.listSkills()
        case 'skill_view':
          return await this.viewSkill(args)
        case 'skill_manage':
          return await this.manage(args as ManageArgs)
        default:
          return { text: `unknown skill tool "${toolName}"`, isError: true }
      }
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), isError: true }
    }
  }

  private async listSkills(): Promise<{ text: string; isError: boolean }> {
    const skills = await this.store.list()
    if (skills.length === 0) return { text: 'The skill library is empty.', isError: false }
    const lines = skills.map(skill => `- ${skill.name}: ${skill.description}${skill.curatorManaged ? '' : ' (user-owned)'}`)
    return { text: lines.join('\n'), isError: false }
  }

  private async viewSkill(args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const name = typeof args.name === 'string' ? args.name : ''
    if (name === '') return { text: 'skill_view requires a name.', isError: true }
    const path = typeof args.path === 'string' && args.path !== '' ? args.path : undefined
    const result = await this.store.view(name, path)
    this.readPaths.add(result.path)
    return { text: result.content, isError: false }
  }

  private requireRead(target: string): void {
    if (!this.readPaths.has(target)) {
      throw new Error('read-before-write: skill_view the target first in this review — the fork may not patch content it only inferred from the transcript')
    }
  }

  private requireSkillRead(name: string): void {
    this.requireRead(this.store.skillFilePath(name))
  }

  private touch(name: string): void {
    if (!this.counts.skills.includes(name)) this.counts.skills.push(name)
  }

  private async manage(args: ManageArgs): Promise<{ text: string; isError: boolean }> {
    const action = args.action ?? ''
    const name = args.name ?? ''
    if (name === '') return { text: 'skill_manage requires a name.', isError: true }
    switch (action) {
      case 'create': {
        if (typeof args.description !== 'string' || args.description.trim() === '') return { text: 'create requires a non-empty description.', isError: true }
        if (typeof args.content !== 'string' || args.content.trim() === '') return { text: 'create requires content.', isError: true }
        await this.store.create(name, args.description, args.content)
        this.counts.created += 1
        this.touch(name)
        this.hooks.onCreate?.(name)
        return { text: `Created skill "${name}".`, isError: false }
      }
      case 'edit': {
        if (typeof args.content !== 'string' || args.content.trim() === '') return { text: 'edit requires content.', isError: true }
        this.requireSkillRead(name)
        await this.store.edit(name, args.content, args.description)
        this.counts.updated += 1
        this.touch(name)
        return { text: `Edited skill "${name}".`, isError: false }
      }
      case 'patch': {
        if (typeof args.find !== 'string' || args.find === '') return { text: 'patch requires find text.', isError: true }
        if (typeof args.replace !== 'string') return { text: 'patch requires replace text.', isError: true }
        const view = await this.store.view(name, args.file_path)
        this.requireRead(view.path)
        await this.store.patch(name, args.file_path, args.find, args.replace)
        this.counts.patched += 1
        this.touch(name)
        return { text: `Patched skill "${name}".`, isError: false }
      }
      case 'delete': {
        this.requireSkillRead(name)
        await this.store.delete(name)
        this.counts.deleted += 1
        this.touch(name)
        this.hooks.onDelete?.(name)
        return { text: `Deleted skill "${name}".`, isError: false }
      }
      case 'write_file': {
        if (typeof args.file_path !== 'string' || args.file_path === '') return { text: 'write_file requires file_path.', isError: true }
        if (typeof args.content !== 'string' || args.content === '') return { text: 'write_file requires content.', isError: true }
        this.requireSkillRead(name)
        await this.store.writeFile(name, args.file_path, args.content)
        this.counts.filesWritten += 1
        this.touch(name)
        return { text: `Wrote ${args.file_path} in skill "${name}".`, isError: false }
      }
      case 'remove_file': {
        if (typeof args.file_path !== 'string' || args.file_path === '') return { text: 'remove_file requires file_path.', isError: true }
        this.requireSkillRead(name)
        await this.store.removeFile(name, args.file_path)
        this.counts.filesRemoved += 1
        this.touch(name)
        return { text: `Removed ${args.file_path} from skill "${name}".`, isError: false }
      }
      default:
        return { text: `unknown skill_manage action "${action}" (create/edit/patch/delete/write_file/remove_file).`, isError: true }
    }
  }
}
