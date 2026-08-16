/**
 * Serialized, cross-process-safe persistence for the two bounded memory
 * files. Write path: in-process promise chain -> cross-process file lock ->
 * reread on-disk truth -> apply -> validate limit -> atomic write. This
 * mirrors the dsh settings-file posture (enqueue + withFileLock +
 * reconcile-from-disk + writeFileAtomic).
 *
 * Known limitation, shared with dsh settings: writeFileAtomic does not
 * fsync — atomic, not durable. A crash may lose the last write; the next
 * session simply re-reads whatever is on disk.
 */

import { readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { codepoints, matchEntries, normalizeOp, parseEntries, serializeEntries } from './entries.js'
import type { MemoryOp } from './entries.js'
import {
  entryTooLargeError,
  invalidTopicNameError,
  lockBusyError,
  overflowError,
  percentOf,
  targetAmbiguousError,
  targetNotFoundError,
  topicNotFoundError,
  topicStoreFullError,
  topicTooLargeError,
} from './errors.js'
import type { FileState } from './errors.js'
import { HIDDEN_ENTRY_PLACEHOLDER, scan } from './scan.js'

export type MemoryFileKey = 'memory' | 'user'

export interface MemoryFileSpec {
  readonly path: string
  /** Display name, e.g. `MEMORY.md`. */
  readonly label: string
  /** Mutable so a live settings change can retune the budget without a restart. */
  limit: number
}

export interface MemoryStoreOptions {
  readonly files: Readonly<Record<MemoryFileKey, MemoryFileSpec>>
  /**
   * Mask scan-flagged entries in error payloads, mirroring the prompt-side
   * masking — errors are the second channel through which on-disk entries
   * reach the model. Mutable so a live settings commit toggles it.
   */
  securityScan: boolean
  /** The progressive-disclosure detail layer; absent = topics not wired. */
  readonly topics?: TopicStoreOptions
}

/** Topic-file store configuration; caps are mutable for live settings. */
export interface TopicStoreOptions {
  readonly dir: string
  /** Per-file byte cap (storage limit; the read window is separate). */
  maxBytes: number
  /** Maximum number of topic files. */
  maxFiles: number
}

export interface TopicInfo {
  readonly name: string
  readonly bytes: number
}

/** Same rule as skill names: kebab-case, so path escape is impossible. */
const TOPIC_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Result of a successful mutation, echoing live post-write usage. */
export interface MutateResult {
  readonly file: MemoryFileKey
  readonly action: MemoryOp['action']
  readonly entries: number
  readonly chars: number
  readonly limit: number
  readonly percent: number
}

/** Point-in-time read of one file for the frozen prompt snapshot. */
export interface FileSnapshot {
  readonly label: string
  readonly limit: number
  readonly entries: readonly string[]
  readonly chars: number
  /** Present when the file could not be read (fail-soft; never brick a session). */
  readonly readError?: string
}

export class MemoryStore {
  /** Single exclusive operation chain across both files (settings-file pattern). */
  private operations: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: MemoryStoreOptions) {}

  spec(file: MemoryFileKey): MemoryFileSpec {
    return this.options.files[file]
  }

  /** Retune one file's budget live (settings watch); future mutations and
   * snapshots observe it, frozen session prompts keep what they rendered. */
  setLimit(file: MemoryFileKey, limit: number): void {
    this.options.files[file].limit = limit
  }

  /** Toggle error-payload masking live (settings watch). */
  setSecurityScan(securityScan: boolean): void {
    this.options.securityScan = securityScan
  }

  /**
   * Replace one file's whole entry list (the /memory compact write path).
   * Same serialized/locked/atomic posture as mutate(); rejected when the
   * consolidated list still exceeds the limit — a compaction that does not
   * fit must not silently truncate.
   */
  async rewrite(file: MemoryFileKey, rawEntries: readonly string[]): Promise<MutateResult> {
    const entries = rawEntries.map(entry => entry.trim().normalize('NFC')).filter(entry => entry !== '')
    return this.enqueue(async () => {
      const spec = this.options.files[file]
      await mkdir(dirname(spec.path), { recursive: true, mode: 0o700 })
      return this.locked(spec, async () => {
        const text = serializeEntries(entries)
        const chars = codepoints(text)
        if (chars > spec.limit) throw overflowError(stateOf(spec, entries, this.options.securityScan), chars)
        await writeFileAtomic(spec.path, text, { mode: 0o600, dirMode: 0o700 })
        return {
          file,
          action: 'replace',
          entries: entries.length,
          chars,
          limit: spec.limit,
          percent: percentOf(chars, spec.limit),
        }
      })
    })
  }

  /**
   * Synchronous read of both files, used to seed the frozen per-session
   * prompt snapshot (the systemPrompt text provider is synchronous).
   */
  readAllSync(): Record<MemoryFileKey, FileSnapshot> {
    const read = (file: MemoryFileKey): FileSnapshot => {
      const spec = this.options.files[file]
      try {
        const raw = readFileSync(spec.path, 'utf8')
        const entries = parseEntries(raw)
        return { label: spec.label, limit: spec.limit, entries, chars: codepoints(serializeEntries(entries)) }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { label: spec.label, limit: spec.limit, entries: [], chars: 0 }
        }
        return {
          label: spec.label,
          limit: spec.limit,
          entries: [],
          chars: 0,
          readError: error instanceof Error ? error.message : String(error),
        }
      }
    }
    return { memory: read('memory'), user: read('user') }
  }

  /**
   * Apply one validated mutation. Match/limit errors are computed against
   * the on-disk truth reread inside the lock, so their payloads are the
   * model's up-to-date recovery channel even when its snapshot is stale.
   */
  async mutate(file: MemoryFileKey, rawOp: MemoryOp): Promise<MutateResult> {
    // NFC so target matching, limit counting, and disk bytes agree.
    const op = normalizeOp(rawOp)
    return this.enqueue(async () => {
      const spec = this.options.files[file]
      const masking = this.options.securityScan
      // The lock file is created next to the target; the directory must exist first.
      await mkdir(dirname(spec.path), { recursive: true, mode: 0o700 })
      return this.locked(spec, async () => {
        const raw = await readFileOrEmpty(spec.path)
        const entries = parseEntries(raw)
        const before = codepoints(serializeEntries(entries))
        const next = applyOp(entries, op, spec, masking)
        const text = serializeEntries(next)
        const chars = codepoints(text)
        // Reject only writes that GROW past the limit. Shrinking ops must
        // always land, or an already-over-limit file (lowered limit, hand
        // edits) could never be brought back under it: every intermediate
        // remove would itself be rejected — a recovery deadlock.
        if (chars > spec.limit && chars > before) {
          const added = op.action === 'add' ? op.content : op.action === 'replace' ? op.newContent : undefined
          if (added !== undefined) {
            const attempted = codepoints(serializeEntries([added]))
            if (attempted > spec.limit) throw entryTooLargeError(spec.label, spec.limit, attempted)
          }
          throw overflowError(stateOf(spec, entries, masking), chars)
        }
        await writeFileAtomic(spec.path, text, { mode: 0o600, dirMode: 0o700 })
        return {
          file,
          action: op.action,
          entries: next.length,
          chars,
          limit: spec.limit,
          percent: percentOf(chars, spec.limit),
        }
      })
    })
  }

  // -- Topic files (progressive-disclosure detail layer) -------------------

  /** Whether the topic detail layer is wired. */
  hasTopics(): boolean {
    return this.options.topics !== undefined
  }

  /** Absolute topics directory, for rendering into the prompt guidance. */
  topicDir(): string {
    const topics = this.requireTopics()
    return resolve(topics.dir)
  }

  /** Live topic caps, for tool result echoes. */
  topicCaps(): { maxBytes: number; maxFiles: number } {
    const topics = this.requireTopics()
    return { maxBytes: topics.maxBytes, maxFiles: topics.maxFiles }
  }

  /** Retune topic caps live (settings watch). */
  setTopicLimits(maxBytes: number, maxFiles: number): void {
    const topics = this.requireTopics()
    topics.maxBytes = maxBytes
    topics.maxFiles = maxFiles
  }

  /** List topic files with sizes, name-sorted; missing directory = empty. */
  async listTopics(): Promise<TopicInfo[]> {
    const topics = this.requireTopics()
    let names: string[]
    try {
      names = (await readdir(topics.dir))
        .filter(file => file.endsWith('.md') && TOPIC_NAME_RE.test(file.slice(0, -3)))
        .map(file => file.slice(0, -3))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const out: TopicInfo[] = []
    for (const name of names) {
      try {
        out.push({ name, bytes: (await stat(this.topicPath(name))).size })
      } catch { /* raced with a remove; skip */ }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Byte size of one topic file, or undefined when absent (gate evidence). */
  async topicSize(name: string): Promise<number | undefined> {
    try {
      return (await stat(this.topicPath(name))).size
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  /** Full text of one topic file. */
  async readTopic(name: string): Promise<string> {
    try {
      return await readFile(this.topicPath(name), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw topicNotFoundError(name, (await this.listTopics()).map(t => t.name))
      }
      throw error
    }
  }

  /** Create or overwrite one topic file (whole content, atomic). */
  async writeTopic(name: string, rawContent: string): Promise<TopicInfo> {
    const content = rawContent.normalize('NFC')
    const bytes = Buffer.byteLength(content, 'utf8')
    const topics = this.requireTopics()
    if (bytes > topics.maxBytes) throw topicTooLargeError(name, bytes, topics.maxBytes)
    return this.enqueue(async () => {
      await mkdir(topics.dir, { recursive: true, mode: 0o700 })
      const path = this.topicPath(name)
      return this.lockedPath(path, `topics/${name}.md`, async () => {
        await this.requireCreateRoom(name, path)
        await writeFileAtomic(path, content, { mode: 0o600, dirMode: 0o700 })
        return { name, bytes }
      })
    })
  }

  /** Append to one topic file (created when absent). */
  async appendTopic(name: string, rawContent: string): Promise<TopicInfo> {
    const addition = rawContent.normalize('NFC')
    const topics = this.requireTopics()
    return this.enqueue(async () => {
      await mkdir(topics.dir, { recursive: true, mode: 0o700 })
      const path = this.topicPath(name)
      return this.lockedPath(path, `topics/${name}.md`, async () => {
        const existing = await readFileOrEmpty(path)
        const combined = existing === '' || existing.endsWith('\n') ? existing + addition : `${existing}\n${addition}`
        const bytes = Buffer.byteLength(combined, 'utf8')
        if (bytes > topics.maxBytes) throw topicTooLargeError(name, bytes, topics.maxBytes)
        if (existing === '') await this.requireCreateRoom(name, path)
        await writeFileAtomic(path, combined, { mode: 0o600, dirMode: 0o700 })
        return { name, bytes }
      })
    })
  }

  /** Delete one topic file. */
  async removeTopic(name: string): Promise<void> {
    const topics = this.requireTopics()
    return this.enqueue(async () => {
      const path = this.topicPath(name)
      return this.lockedPath(path, `topics/${name}.md`, async () => {
        try {
          await rm(path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw topicNotFoundError(name, (await this.listTopics()).map(t => t.name))
          }
          throw error
        }
      })
    })
  }

  private requireTopics(): TopicStoreOptions {
    if (this.options.topics === undefined) throw new Error('topic store is not wired in this profile')
    return this.options.topics
  }

  private topicPath(name: string): string {
    if (!TOPIC_NAME_RE.test(name)) throw invalidTopicNameError(name)
    const topics = this.requireTopics()
    const path = resolve(topics.dir, `${name}.md`)
    if (!path.startsWith(resolve(topics.dir) + sep)) throw invalidTopicNameError(name)
    return path
  }

  /** Refuse a create that would exceed the file-count cap (overwrite is fine). */
  private async requireCreateRoom(name: string, path: string): Promise<void> {
    const topics = this.requireTopics()
    try {
      await stat(path)
      return // overwrite of an existing file
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if ((await this.listTopics()).length >= topics.maxFiles) throw topicStoreFullError(topics.maxFiles)
  }

  /**
   * withFileLock, with its bare timeout Error translated into a model-facing
   * one carrying conditional recovery guidance (the library treats orphaned
   * locks as an operator action and never cleans them up itself).
   */
  private async locked<T>(spec: MemoryFileSpec, operation: () => Promise<T>): Promise<T> {
    return this.lockedPath(spec.path, spec.label, operation)
  }

  private async lockedPath<T>(path: string, label: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await withFileLock(path, operation)
    } catch (error) {
      if (error instanceof Error && error.message.includes('timed out waiting for the writer lock')) {
        throw lockBusyError(label, `${path}.lock`)
      }
      throw error
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation)
    // A failed operation must never poison the chain for later ones.
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }
}

/**
 * Error-payload view of the on-disk state. Entries the scan flags are
 * masked with the same placeholder the prompt side uses; `chars` always
 * reflects the real serialized content.
 */
function stateOf(spec: MemoryFileSpec, entries: readonly string[], masking: boolean): FileState {
  return {
    label: spec.label,
    limit: spec.limit,
    entries: maskScanned(entries, masking),
    chars: codepoints(serializeEntries(entries)),
  }
}

function maskScanned(entries: readonly string[], masking: boolean): readonly string[] {
  if (!masking) return entries
  return entries.map(entry => (scan(entry) === undefined ? entry : HIDDEN_ENTRY_PLACEHOLDER))
}

function applyOp(entries: readonly string[], op: MemoryOp, spec: MemoryFileSpec, masking: boolean): string[] {
  switch (op.action) {
    case 'add':
      return [...entries, op.content]
    case 'replace': {
      const index = requireUnique(entries, op.target, spec, masking)
      const next = [...entries]
      next[index] = op.newContent
      return next
    }
    case 'remove': {
      const index = requireUnique(entries, op.target, spec, masking)
      const next = [...entries]
      next.splice(index, 1)
      return next
    }
  }
}

function requireUnique(entries: readonly string[], target: string, spec: MemoryFileSpec, masking: boolean): number {
  const match = matchEntries(entries, target)
  if (match.kind === 'none') throw targetNotFoundError(stateOf(spec, entries, masking), target)
  if (match.kind === 'many') {
    throw targetAmbiguousError(
      stateOf(spec, entries, masking),
      target,
      maskScanned(match.indexes.map(i => entries[i]!), masking),
    )
  }
  return match.index
}

async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}
