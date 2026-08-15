/**
 * Host half of the web memory panel: a Typert Remote service exposing
 * list / mutate / listReviewRuns over dsh's shared RPC carrier (namespace
 * `memoryHermes`).
 *
 * Panel edits skip the model-facing gates on purpose: the approval gate
 * guards model-initiated writes (the panel user IS the approver), and the
 * security scan guards what the model can persist — the owner editing their
 * own files is outside both threat models. Scan hits are still surfaced as
 * a `flagged` marker so the panel can warn instead of mask.
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { percentOf } from './errors.js'
import type { ReviewRun } from './reviewlog.js'
import { scan } from './scan.js'
import type { MemoryFileKey, MemoryStore, MutateResult } from './store.js'
import { validateMemoryArgs } from './tool.js'
import type { MemoryToolArgs } from './tool.js'

export const GATEWAY_NAMESPACE = 'memoryHermes'

export interface PanelEntry {
  readonly text: string
  /** The security scan would reject this content; shown as a warning, never masked. */
  readonly flagged: boolean
}

export interface PanelFile {
  readonly key: MemoryFileKey
  readonly label: string
  readonly limit: number
  readonly chars: number
  readonly percent: number
  readonly entries: readonly PanelEntry[]
  readonly readError?: string
}

export interface PanelListResult {
  readonly files: readonly PanelFile[]
}

/** Errors travel as data so the panel renders store messages verbatim. */
export type PanelMutateOutcome =
  | { readonly ok: true; readonly result: MutateResult }
  | { readonly ok: false; readonly message: string }

/** Review-run history for the panel's activity tab. */
export interface PanelReviewRunsResult {
  readonly runs: readonly ReviewRun[]
}

/** One activity row (type alias so the client half imports it type-only). */
export type PanelReviewRun = ReviewRun

/** One skill-library row for the panel's skills tab. */
export interface PanelSkill {
  readonly name: string
  readonly description: string
  readonly curatorManaged: boolean
}

export interface PanelSkillsResult {
  readonly skills: readonly PanelSkill[]
}

/** Structural view of the skill store's list seam. */
export interface SkillListSource {
  list(): Promise<readonly PanelSkill[]>
}

export class MemoryHermesGateway extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly store: MemoryStore,
    private readonly reviewRuns: () => Promise<readonly ReviewRun[]> | readonly ReviewRun[] = () => [],
    private readonly skillStore?: SkillListSource,
  ) {
    super(ctx, GATEWAY_NAMESPACE)
  }

  @Remote('list')
  list(): PanelListResult {
    const snapshots = this.store.readAllSync()
    const files = (['memory', 'user'] as const).map((key): PanelFile => {
      const snap = snapshots[key]
      return {
        key,
        label: snap.label,
        limit: snap.limit,
        chars: snap.chars,
        percent: percentOf(snap.chars, snap.limit),
        entries: snap.entries.map(text => ({ text, flagged: scan(text) !== undefined })),
        ...snap.readError === undefined ? {} : { readError: snap.readError },
      }
    })
    return { files }
  }

  @Remote('mutate')
  async mutate(op: MemoryToolArgs): Promise<PanelMutateOutcome> {
    try {
      const call = validateMemoryArgs(op)
      const result = await this.store.mutate(call.file, call.op)
      return { ok: true, result }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  @Remote('listReviewRuns')
  async listReviewRuns(): Promise<PanelReviewRunsResult> {
    return { runs: await this.reviewRuns() }
  }

  @Remote('listSkills')
  async listSkills(): Promise<PanelSkillsResult> {
    if (this.skillStore === undefined) return { skills: [] }
    const skills = await this.skillStore.list()
    return { skills: skills.map(skill => ({ name: skill.name, description: skill.description, curatorManaged: skill.curatorManaged })) }
  }
}
