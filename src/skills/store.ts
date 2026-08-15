/**
 * Curator skill store: the on-disk skill library the review fork evolves.
 * Layout mirrors Hermes — `<root>/<name>/SKILL.md` plus `references/`,
 * `templates/`, `scripts/`, `assets/` support dirs — and the root IS dsh's
 * user skill root (`$DSH_HOME/skills`), so the dsh filesystem skill provider
 * picks new skills up for every session's catalog with zero extra wiring.
 *
 * Mutation posture mirrors the memory store: in-process promise chain ->
 * per-skill file lock -> re-read -> apply -> atomic write. Provenance is the
 * frontmatter `created_by: agent` marker; mutations of unmarked (user-owned)
 * skills are refused, and an unreadable marker fails closed.
 *
 * @module dsh-memory-hermes/skills/store
 */

import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { CURATOR_MARKER, adoptSkillText, isCuratorManaged, parseFrontmatter, renderSkillFile } from './provenance.js'

/** Support-file directories a write_file/remove_file may target. */
export const SUPPORT_DIRS = ['references', 'templates', 'scripts', 'assets'] as const

export interface SkillSummary {
  readonly name: string
  readonly description: string
  /** Absolute skill directory. */
  readonly dir: string
  readonly curatorManaged: boolean
}

export interface SkillStoreOptions {
  readonly root: string
  /** Per-file size cap for write_file and patch targets. */
  readonly maxFileBytes: number
}

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function assertSkillName(name: string): void {
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(`invalid skill name "${name}": use kebab-case (lowercase letters, digits, dashes)`)
  }
}

export class CuratorSkillStore {
  /** Single exclusive operation chain across the whole library. */
  private operations: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: SkillStoreOptions) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }

  private skillDir(name: string): string {
    assertSkillName(name)
    const dir = resolve(this.options.root, name)
    const root = resolve(this.options.root)
    if (dir !== join(root, name)) throw new Error(`skill name "${name}" escapes the skill root`)
    return dir
  }

  /** Public path of one skill's SKILL.md (the read-before-write evidence key). */
  skillFilePath(name: string): string {
    return join(this.skillDir(name), 'SKILL.md')
  }

  /** Resolve a support-file path, refusing anything outside the skill dir. */
  private supportPath(dir: string, relPath: string): string {
    const top = relPath.split(/[\\/]/, 1)[0] ?? ''
    if (!(SUPPORT_DIRS as readonly string[]).includes(top)) {
      throw new Error(`support file path must start with one of: ${SUPPORT_DIRS.join(', ')}`)
    }
    const target = resolve(dir, relPath)
    if (target !== dir && !target.startsWith(dir + sep)) {
      throw new Error(`support file path "${relPath}" escapes the skill directory`)
    }
    return target
  }

  private async readSkillFile(dir: string): Promise<string> {
    try {
      return await readFile(join(dir, 'SKILL.md'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('skill not found')
      throw error
    }
  }

  private async requireCuratorManaged(dir: string, name: string): Promise<string> {
    let text: string
    try {
      text = await this.readSkillFile(dir)
    } catch (error) {
      // Fail closed: an unreadable marker means user-owned by default.
      if (error instanceof Error && error.message === 'skill not found') throw error
      throw new Error(`refusing to mutate skill "${name}": provenance unreadable (${error instanceof Error ? error.message : String(error)})`)
    }
    if (!isCuratorManaged(text)) {
      throw new Error(`refusing to mutate skill "${name}": it is not curator-managed (no 'created_by: ${CURATOR_MARKER}' marker). User-owned skills are off-limits to autonomous curation`)
    }
    return text
  }

  /** Depth-1 scan for `<root>/<name>/SKILL.md` — dsh's own skill discovery
   * depth, so this library never grows layouts the harness cannot see. */
  async list(): Promise<SkillSummary[]> {
    const root = resolve(this.options.root)
    const out: SkillSummary[] = []
    const scan = async (dir: string, name: string): Promise<void> => {
      try {
        const text = await readFile(join(dir, 'SKILL.md'), 'utf8')
        const { meta } = parseFrontmatter(text)
        out.push({
          name: meta.name ?? name,
          description: meta.description ?? '',
          dir,
          curatorManaged: isCuratorManaged(text),
        })
      } catch { /* not a skill dir */ }
    }
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    /** Junction/symlink-aware directory check (users link skills in). */
    const isDir = async (path: string, dirent: { isDirectory(): boolean; isSymbolicLink(): boolean }): Promise<boolean> => {
      if (dirent.isDirectory()) return true
      if (!dirent.isSymbolicLink()) return false
      try {
        return (await stat(path)).isDirectory()
      } catch {
        return false
      }
    }
    for (const entry of entries) {
      const dir = join(root, entry.name)
      if (!(await isDir(dir, entry))) continue
      await scan(dir, entry.name)
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Read SKILL.md body, or one support file when relPath is given. */
  async view(name: string, relPath?: string): Promise<{ path: string; content: string }> {
    const dir = this.skillDir(name)
    if (relPath === undefined) {
      const text = await this.readSkillFile(dir)
      return { path: join(dir, 'SKILL.md'), content: text }
    }
    const target = this.supportPath(dir, relPath)
    try {
      return { path: target, content: await readFile(target, 'utf8') }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`support file not found: ${relPath}`)
      throw error
    }
  }

  /** skill_manage(create): new skill skeleton with the curator marker. */
  async create(name: string, description: string, body: string): Promise<SkillSummary> {
    const dir = this.skillDir(name)
    return this.enqueue(async () => {
      await mkdir(dir, { recursive: true })
      try {
        await readFile(join(dir, 'SKILL.md'), 'utf8')
        throw new Error(`skill "${name}" already exists`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const text = renderSkillFile({ name, description, createdBy: CURATOR_MARKER }, body)
      await writeFileAtomic(join(dir, 'SKILL.md'), text, { mode: 0o600, dirMode: 0o700 })
      for (const sub of SUPPORT_DIRS) await mkdir(join(dir, sub), { recursive: true })
      return { name, description, dir, curatorManaged: true }
    })
  }

  /** skill_manage(edit): full SKILL.md body rewrite, frontmatter preserved. */
  async edit(name: string, body: string, description?: string): Promise<void> {
    const dir = this.skillDir(name)
    return this.enqueue(async () => {
      await this.locked(dir, async () => {
        const current = await this.requireCuratorManaged(dir, name)
        const { meta } = parseFrontmatter(current)
        const text = renderSkillFile({
          name: meta.name ?? name,
          description: description ?? meta.description ?? '',
          createdBy: CURATOR_MARKER,
        }, body)
        this.assertSize(text)
        await writeFileAtomic(join(dir, 'SKILL.md'), text, { mode: 0o600, dirMode: 0o700 })
      })
    })
  }

  /** skill_manage(patch): targeted find-and-replace; find must match exactly once. */
  async patch(name: string, relPath: string | undefined, find: string, replacement: string): Promise<void> {
    const dir = this.skillDir(name)
    const target = relPath === undefined ? join(dir, 'SKILL.md') : this.supportPath(dir, relPath)
    return this.enqueue(async () => {
      await this.locked(dir, async () => {
        await this.requireCuratorManaged(dir, name)
        let text: string
        try {
          text = await readFile(target, 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`patch target not found: ${relPath ?? 'SKILL.md'}`)
          throw error
        }
        const first = text.indexOf(find)
        const last = text.lastIndexOf(find)
        if (first === -1) throw new Error('patch find text matches nothing')
        if (first !== last) throw new Error('patch find text matches more than once — make it longer')
        const next = text.slice(0, first) + replacement + text.slice(first + find.length)
        this.assertSize(next)
        await writeFileAtomic(target, next, { mode: 0o600, dirMode: 0o700 })
      })
    })
  }

  /** skill_manage(delete): remove a curator-managed skill entirely. */
  async delete(name: string): Promise<void> {
    const dir = this.skillDir(name)
    return this.enqueue(async () => {
      await this.locked(dir, async () => {
        await this.requireCuratorManaged(dir, name)
        await rm(dir, { recursive: true, force: true })
      })
    })
  }

  /**
   * Jurisdiction transfer (`/memory adopt`): mark a user-owned skill
   * curator-managed. Deliberately NOT behind the provenance gate — the
   * operator themselves is moving the boundary, and the gate exists to stop
   * the autonomous fork, not the user.
   */
  async adopt(name: string): Promise<void> {
    const dir = this.skillDir(name)
    return this.enqueue(async () => {
      await this.locked(dir, async () => {
        const text = await this.readSkillFile(dir)
        if (isCuratorManaged(text)) throw new Error(`skill "${name}" is already curator-managed`)
        await writeFileAtomic(join(dir, 'SKILL.md'), adoptSkillText(text), { mode: 0o600, dirMode: 0o700 })
      })
    })
  }

  /** skill_manage(write_file): add/overwrite one support file. */
  async writeFile(name: string, relPath: string, content: string): Promise<void> {
    const dir = this.skillDir(name)
    const target = this.supportPath(dir, relPath)
    return this.enqueue(async () => {
      await this.locked(dir, async () => {
        await this.requireCuratorManaged(dir, name)
        this.assertSize(content)
        await mkdir(dirname(target), { recursive: true })
        await writeFileAtomic(target, content, { mode: 0o600, dirMode: 0o700 })
      })
    })
  }

  /** skill_manage(remove_file): remove one support file. */
  async removeFile(name: string, relPath: string): Promise<void> {
    const dir = this.skillDir(name)
    const target = this.supportPath(dir, relPath)
    return this.enqueue(async () => {
      await this.locked(dir, async () => {
        await this.requireCuratorManaged(dir, name)
        await rm(target, { force: true })
      })
    })
  }

  private assertSize(text: string): void {
    if (Buffer.byteLength(text, 'utf8') > this.options.maxFileBytes) {
      throw new Error(`content exceeds the ${this.options.maxFileBytes}-byte skill file cap`)
    }
  }

  private async locked<T>(dir: string, operation: () => Promise<T>): Promise<T> {
    await mkdir(dir, { recursive: true })
    return withFileLock(join(dir, '.skill.lock'), operation)
  }
}
