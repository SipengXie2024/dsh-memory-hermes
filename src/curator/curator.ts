/**
 * The curator pass: Hermes' second maintenance layer, ported 1:1 in spirit.
 * Where the per-turn review distills SESSIONS into skills, the curator
 * periodically reviews the LIBRARY itself — umbrella-building consolidation
 * driven by an LLM fork over the same bounded loop.
 *
 * Deviations from Hermes, per the v4 proposal:
 * - deletes are permanent (no archive tier); the pre-run snapshot is the
 *   only safety net, and the read-before-write gate forces a view first;
 * - no cron machinery, no protected built-ins (provenance carries that);
 * - the aggressiveness calibration ("fewer than 10 archives = stopped too
 *   early") is dropped — it was written for a several-hundred-skill library
 *   and would goad over-deletion in a library of single digits.
 *
 * @module dsh-memory-hermes/curator/curator
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { runForkLoop } from '../forkloop.js'
import type { ReviewLog, ReviewRun, SkillTelemetry, SkillUsage } from '../reviewlog.js'
import { deadline } from '../review.js'
import type { Resolved } from '../config.js'
import type { ConfigSource } from '../settings.js'
import type { CuratorSkillStore, SkillSummary } from '../skills/store.js'
import { ForkSkillTools, SKILL_TOOL_NAMES, forkSkillToolSchemas } from '../skills/tools.js'
import type { SkillActionCounts, SkillMutationHooks } from '../skills/tools.js'
import { snapshotCuratorSkills } from './backup.js'
import { sweepLifecycle } from './lifecycle.js'
import type { LifecycleSweep } from './lifecycle.js'

/**
 * Hermes CURATOR_REVIEW_PROMPT, ported. The consolidation methodology and
 * the package-integrity rules are verbatim in substance; the delete
 * semantics, tool surface, and the depth-1 layout constraint are ours.
 */
export const CURATOR_PROMPT
  = 'You are running as the background skill CURATOR. This is an UMBRELLA-BUILDING '
  + 'consolidation pass, not a passive audit and not a duplicate-finder.\n\n'
  + 'The goal of the skill collection is a LIBRARY OF CLASS-LEVEL INSTRUCTIONS AND '
  + 'EXPERIENTIAL KNOWLEDGE. A collection of hundreds of narrow skills where each one '
  + 'captures one session\'s specific bug is a FAILURE of the library — not a feature. '
  + 'An agent searching skills matches on descriptions, not on exact names. One broad '
  + 'umbrella skill with labeled subsections beats five narrow siblings for '
  + 'discoverability, not the other way around.\n\n'
  + 'The right target shape is CLASS-LEVEL skills with rich SKILL.md bodies + '
  + '`references/`, `templates/`, and `scripts/` subfiles for session-specific detail '
  + '— not one-session-one-skill micro-entries.\n\n'
  + 'Hard rules — do not violate:\n'
  + '1. The list below covers the whole library, but only entries marked managed=yes '
  + 'are candidates. Entries marked managed=no are user-owned, read-only context — '
  + 'the tools refuse mutations of them. Use them to avoid duplicating a topic the '
  + 'user already covers; never try to modify or delete them.\n'
  + '2. Deletes are PERMANENT — there is no archive. A pre-run snapshot exists for '
  + 'disaster recovery, but treat every delete as final. You MUST have viewed a skill '
  + '(skill_view) during THIS run before deleting it; the tools enforce this.\n'
  + '3. DO NOT touch skills shown as pinned=yes. Skip them entirely.\n'
  + '4. DO NOT use usage counters as a reason to skip consolidation. The counters are '
  + 'new and often mostly zero. Judge overlap on CONTENT, not on use count. \'use=0\' '
  + 'is not evidence a skill is valuable; it\'s absence of evidence either way. '
  + 'Corollary: \'use=0\' is ALSO not a reason to DELETE a skill. Never delete a '
  + 'never-used skill unless it is past its grace window (shown as state=stale) AND '
  + 'its content is genuinely obsolete or fully absorbed elsewhere — a '
  + 'recently-created skill simply may not have had its trigger come up yet.\n'
  + '5. DO NOT reject consolidation on the grounds that \'each skill has a distinct '
  + 'trigger\'. Pairwise distinctness is the wrong bar. The right bar is: \'would a '
  + 'human maintainer write this as N separate skills, or as one skill with N labeled '
  + 'subsections?\' When the answer is the latter, merge.\n'
  + '6. Umbrella skills MUST live at the library root as `<name>/SKILL.md`. The '
  + 'harness only discovers skills one level deep — a skill nested under a category '
  + 'directory silently never enters the catalog. Never invent directory groupings; '
  + 'hierarchy lives INSIDE a skill package (SKILL.md subsections plus `references/` '
  + 'files), not in the directory tree.\n\n'
  + 'How to work — not optional:\n'
  + '1. Scan the full candidate list. Identify PREFIX CLUSTERS (skills sharing a '
  + 'first word or domain keyword). For each cluster with 2+ members, do NOT ask '
  + '\'are these pairs overlapping?\' — ask \'what is the UMBRELLA CLASS these skills '
  + 'all serve? Would a maintainer name that class and write one skill for it?\' If '
  + 'yes, pick (or create) the umbrella and absorb the siblings into it.\n'
  + '2. Three ways to consolidate — use the right one per cluster:\n'
  + '   a. MERGE INTO EXISTING UMBRELLA — one skill in the cluster is already broad '
  + 'enough to be the umbrella. Patch it to add a labeled section for each sibling\'s '
  + 'unique insight, then delete the siblings.\n'
  + '   b. CREATE A NEW UMBRELLA SKILL.md — no existing member is broad enough. Use '
  + 'skill_manage action=create to write a new class-level skill whose SKILL.md '
  + 'covers the shared workflow and has short labeled subsections. Delete the '
  + 'now-absorbed narrow siblings.\n'
  + '   c. DEMOTE TO REFERENCES/TEMPLATES/SCRIPTS — a sibling has narrow-but-valuable '
  + 'session-specific content. Move it into the umbrella\'s appropriate support '
  + 'directory with skill_manage action=write_file:\n'
  + '      - `references/<topic>.md` for session-specific detail or condensed '
  + 'knowledge banks (quoted research, API docs excerpts, domain notes, provider '
  + 'quirks, reproduction recipes)\n'
  + '      - `templates/<name>.<ext>` for starter files meant to be copied and '
  + 'modified\n'
  + '      - `scripts/<name>.<ext>` for statically re-runnable actions (verification '
  + 'scripts, fixture generators, probes)\n'
  + '      Then delete the old sibling.\n\n'
  + 'Package integrity — not optional:\n'
  + 'Before demoting or deleting a skill, inspect it as a COMPLETE directory package, '
  + 'not just SKILL.md. A skill root may include `references/`, `templates/`, '
  + '`scripts/`, and `assets/`. If the source skill has support files OR its SKILL.md '
  + 'contains relative links such as `references/...`, `templates/...`, '
  + '`scripts/...`, or `assets/...`, DO NOT flatten only SKILL.md into '
  + '`<umbrella>/references/<old>.md`. Choose one safe path instead:\n'
  + '   - keep it as a standalone skill, OR\n'
  + '   - fully merge it by re-homing every needed support file into the umbrella\'s '
  + 'canonical support directories (skill_view each file, then write_file it under '
  + 'the umbrella) AND rewrite the destination instructions to the new paths, OR\n'
  + '   - leave the original skill package unchanged.\n'
  + 'Never leave surviving instructions pointing at files that no longer exist.\n\n'
  + 'Also flag skills whose NAME is too narrow (contains a ticket number, a feature '
  + 'codename, a specific error string, an \'audit\' / \'diagnosis\' session '
  + 'artifact). These almost always belong as a subsection or support file under a '
  + 'class-level umbrella.\n\n'
  + 'Iterate. After one consolidation round, scan the remaining set and look for the '
  + 'NEXT umbrella opportunity.\n\n'
  + 'Your toolset:\n'
  + '  - skills_list, skill_view        — read the current landscape\n'
  + '  - skill_manage action=patch      — add sections to the umbrella\n'
  + '  - skill_manage action=create     — create a new umbrella SKILL.md\n'
  + '  - skill_manage action=write_file — add a references/, templates/, or scripts/ '
  + 'file under an existing skill\n'
  + '  - skill_manage action=delete     — permanently remove a skill you have viewed '
  + 'this run\n\n'
  + '\'keep\' is a legitimate decision ONLY when the skill is already a class-level '
  + 'umbrella and none of the proposed merges would improve discoverability. \'This '
  + 'is narrow but distinct from its siblings\' is NOT a reason to keep — it\'s a '
  + 'reason to move it under an umbrella as a subsection or support file. A small '
  + 'library that is already class-shaped needs no action — say so and stop.\n\n'
  + 'When done, write a short human-readable summary of clusters processed, merges '
  + 'made, and decisions left alone.'

const iso = (ms: number | undefined): string => (ms === undefined ? 'never' : new Date(ms).toISOString())

/**
 * The whole library, one line per skill, with telemetry evidence inline.
 * Managed entries carry lifecycle columns; user-owned entries only usage
 * (they have no lifecycle — the sweep never touches them).
 */
export function renderCandidateList(
  skills: readonly SkillSummary[],
  telemetry: ReadonlyMap<string, SkillUsage>,
): string {
  if (skills.length === 0) return 'The skill library is empty.'
  const lines = [`Skill library (${skills.length}):`, '']
  for (const skill of skills) {
    const usage = telemetry.get(skill.name)
    const use = `use=${usage?.useCount ?? 0}  last_used=${iso(usage?.lastUsedAt)}`
    const line = skill.curatorManaged
      ? `- ${skill.name}  managed=yes  state=${usage?.state ?? 'active'}  pinned=${usage?.pinned === true ? 'yes' : 'no'}  ${use}`
      : `- ${skill.name}  managed=no  ${use}`
    lines.push(`${line} — ${skill.description === '' ? '(no description)' : skill.description}`)
  }
  return lines.join('\n')
}

export interface CuratorDeps {
  readonly configSource: ConfigSource
  readonly skillStore: CuratorSkillStore
  readonly telemetry: SkillTelemetry
  readonly reviewLog?: ReviewLog
  readonly skillHooks?: SkillMutationHooks
  /** Snapshot root, outside the library (e.g. `$DSH_HOME/skill-backups`). */
  readonly backupRoot: string
  /** Final model fallback (agentDefaultModel.currentSelection). */
  readonly defaultModel?: () => { provider: string; model: string } | undefined
}

/** curatorProvider/Model -> reviewProvider/Model -> the agent default. */
export function resolveCuratorRoute(
  config: Resolved,
  defaultModel?: () => { provider: string; model: string } | undefined,
): { provider: string; model: string } | undefined {
  if (config.curatorProvider !== undefined && config.curatorModel !== undefined) {
    return { provider: config.curatorProvider, model: config.curatorModel }
  }
  if (config.reviewProvider !== undefined && config.reviewModel !== undefined) {
    return { provider: config.reviewProvider, model: config.reviewModel }
  }
  return defaultModel?.()
}

export interface CuratorOutcome {
  readonly status: 'ran' | 'swept' | 'disabled' | 'no-model' | 'failed'
  readonly sweep?: LifecycleSweep
  readonly backupDir?: string
  readonly steps?: number
  readonly skillActions?: SkillActionCounts
  readonly error?: string
}

/**
 * One curator pass. The deterministic sweep always runs (it is
 * zero-destruction); the LLM consolidation loop runs only when enabled and
 * there is something curator-managed to work on. Every pass — including
 * failures — lands one `kind: 'curator'` run in the sidecar.
 */
export async function curatorOnce(
  ctx: Context,
  deps: CuratorDeps,
  options: { readonly signal: AbortSignal; readonly now?: number },
): Promise<CuratorOutcome> {
  const config = deps.configSource.get()
  if (!config.curatorEnabled) return { status: 'disabled' }
  const startedAt = Date.now()
  const now = options.now ?? startedAt

  const record = async (partial: Partial<ReviewRun>): Promise<void> => {
    await deps.reviewLog?.record({
      id: crypto.randomUUID(),
      sessionId: 'curator',
      turn: -1,
      kind: 'curator',
      startedAt,
      settledAt: Date.now(),
      applied: 0,
      rejected: 0,
      malformed: 0,
      foreign: 0,
      ...partial,
    }).catch((error: unknown) => {
      ctx.logger.warn(`memory-hermes curator: run log write failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  let sweep: LifecycleSweep | undefined
  try {
    const skills = await deps.skillStore.list()
    const managed = skills.filter(skill => skill.curatorManaged)
    sweep = await sweepLifecycle(deps.telemetry, managed.map(skill => skill.name), now, config.curatorStaleAfterDays)
    const sweepLine = `sweep: ${sweep.transitions.length} state transition(s), ${sweep.seeded.length} row(s) seeded`

    if (!config.curatorConsolidate || managed.length === 0) {
      const why = managed.length === 0
        ? 'no curator-managed skills; consolidation skipped'
        : 'consolidation disabled (curatorConsolidate: false)'
      await record({ trace: [sweepLine, why] })
      return { status: 'swept', sweep }
    }

    const route = resolveCuratorRoute(config, deps.defaultModel)
    if (route === undefined) {
      const error = 'no model route: set curatorProvider/curatorModel or reviewProvider/reviewModel'
      await record({ trace: [sweepLine], error })
      return { status: 'no-model', sweep, error }
    }

    const backup = await snapshotCuratorSkills({
      store: deps.skillStore,
      telemetry: deps.telemetry,
      root: deps.backupRoot,
      maxBackups: config.curatorMaxBackups,
    }, now)
    const backupLine = `snapshot: ${backup.skills.length} skill(s) -> ${backup.dir ?? '(none)'}`

    // Cold input: no session prefix, so the model choice is cache-free.
    const messages: Message[] = [createUserMessage({
      content: [{ type: 'text', text: `${CURATOR_PROMPT}\n\n${renderCandidateList(skills, deps.telemetry.list())}` }],
      source: { kind: 'plugin', plugin: 'dsh-memory-hermes' },
    })]
    // Fresh per run: read-before-write evidence must not leak across runs.
    const forkTools = new ForkSkillTools(deps.skillStore, deps.skillHooks)
    let foreign = 0
    const loop = await runForkLoop(ctx, {
      provider: route.provider as GenerateOptions['provider'],
      model: route.model as GenerateOptions['model'],
      messages,
      tools: forkSkillToolSchemas() as unknown as NonNullable<GenerateOptions['tools']>,
      maxSteps: config.curatorMaxSteps,
      maxTokens: config.curatorMaxTokens,
      signal: deadline(options.signal, config.curatorTimeoutMs),
      dispatch: async (toolCall) => {
        if ((SKILL_TOOL_NAMES as readonly string[]).includes(toolCall.name)) {
          return forkTools.execute(toolCall.name, toolCall.arguments)
        }
        foreign += 1
        return { text: `tool "${toolCall.name}" is not available in the curator pass`, isError: true }
      },
    })

    await record({
      steps: loop.steps,
      foreign,
      skillActions: forkTools.counts,
      trace: [sweepLine, backupLine, ...loop.trace],
    })
    return {
      status: 'ran',
      sweep,
      ...backup.dir === undefined ? {} : { backupDir: backup.dir },
      steps: loop.steps,
      skillActions: forkTools.counts,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await record({ error: message })
    ctx.logger.warn(`memory-hermes curator failed: ${message}`)
    return { status: 'failed', ...sweep === undefined ? {} : { sweep }, error: message }
  }
}
