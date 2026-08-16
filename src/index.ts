/**
 * Hermes-style bounded curated memory for DeepSeek Harness, as an
 * out-of-tree user plugin: two small persistent files (MEMORY.md agent
 * notes + USER.md user profile), a single `memory` tool (add / replace /
 * remove, unique-substring matching, overflow discipline with
 * current-entries payloads), and a per-session frozen system-prompt
 * snapshot.
 *
 * v2 wiring: tunables are a live settings namespace (composition config as
 * `base`); the approval gate is a tools/pre-execute policy listener; the
 * background review triggers on turn-end policy (tokenMeter-priced), on
 * compaction-start harvests, and on /memory review, and records every pass
 * to a storage-domain sidecar the settings page renders; a projection unit
 * folds each session's memory activity out of its own log.
 *
 * @module dsh-memory-hermes
 */

import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installMemoryCommand } from './command.js'
import { runCompact } from './compact.js'
import { Config } from './config.js'
import type { Resolved } from './config.js'
import { countLibrary, createSkillAdmin, renderCuratorOutcome, renderCuratorStatus } from './curator/admin.js'
import { installCuratorScheduler } from './curator/scheduler.js'
import type { CuratorControl } from './curator/scheduler.js'
import { createSkillTelemetryHooks, installUsageTelemetry } from './curator/telemetry.js'
import { MemoryHermesGateway } from './gateway.js'
import { installApprovalPolicy } from './policy.js'
import { installProjection } from './projection.js'
import { createSnapshotSection } from './prompt.js'
import { installReview } from './review.js'
import type { ReviewControl, TokenMeterLike } from './review.js'
import { createSidecar } from './reviewlog.js'
import { createConfigSource } from './settings.js'
import { CuratorSkillStore } from './skills/store.js'
import { MemoryStore } from './store.js'
import { buildMemoryTool } from './tool.js'

export const name = 'memory-hermes'
export const inject = ['tools', 'systemPrompt']

export { Config } from './config.js'
export type { Config as ConfigShape } from './config.js'

export function apply(ctx: Context, config: Config): void {
  // Re-run the schema so defaults and bounds hold even when apply is called
  // directly, outside Loader normalization (schemastery fills and validates).
  const loaderResolved = new Config(config) as Resolved
  const warn = (message: string): void => { ctx.logger.warn(message) }
  const configSource = createConfigSource(ctx, loaderResolved, Config, warn)

  const initial = configSource.get()
  const store = new MemoryStore({
    files: {
      memory: {
        path: dshHomePath('memory', 'MEMORY.md'),
        label: 'MEMORY.md',
        limit: initial.memoryCharLimit,
      },
      user: {
        path: dshHomePath('memory', 'USER.md'),
        label: 'USER.md',
        limit: initial.userCharLimit,
      },
    },
    securityScan: initial.securityScan,
  })
  // Live tunables: a settings commit retunes limits and the scan without a
  // restart (frozen per-session prompt snapshots keep what they rendered).
  configSource.watch((next) => {
    store.setLimit('memory', next.memoryCharLimit)
    store.setLimit('user', next.userCharLimit)
    store.setSecurityScan(next.securityScan)
  })

  ctx.systemPrompt.section(createSnapshotSection(store, () => configSource.get().securityScan))
  ctx.tools.register(defineTool(buildMemoryTool({
    store,
    securityScan: () => configSource.get().securityScan,
  })))
  installApprovalPolicy(ctx, configSource)

  const sidecar = createSidecar(ctx, () => configSource.get().reviewHistoryLimit, warn)
  // The skill route's library: dsh's own user skill root by default, so
  // curator skills land in every session's catalog via the stock filesystem
  // skill provider (which watches that root).
  const skillStore = new CuratorSkillStore({
    root: configSource.get().skillRoot ?? dshHomePath('skills'),
    maxFileBytes: configSource.get().skillMaxBytes,
  })
  // The curator's lifecycle evidence: real foreground use of skills.
  const skillHooks = createSkillTelemetryHooks({ telemetry: sidecar.telemetry, configSource })
  installUsageTelemetry(ctx, { telemetry: sidecar.telemetry, configSource })
  const skillAdmin = createSkillAdmin(skillStore, sidecar.telemetry)
  let reviewControl: ReviewControl | undefined
  let curatorControl: CuratorControl | undefined
  ctx.inject(['llm'], (scoped) => {
    reviewControl = installReview(scoped, {
      store,
      configSource,
      reviewLog: sidecar.log,
      tokenMeter: scoped.get('tokenMeter') as TokenMeterLike | undefined,
      skillStore,
      skillHooks,
    })
    // The library-maintenance layer: hourly idle probe + manual trigger.
    curatorControl = installCuratorScheduler(scoped, {
      configSource,
      skillStore,
      telemetry: sidecar.telemetry,
      reviewLog: sidecar.log,
      skillHooks,
      backupRoot: dshHomePath('skill-backups'),
      defaultModel: () => (scoped.get('agentDefaultModel') as { currentSelection?: () => { provider: string; model: string } | undefined } | undefined)?.currentSelection?.(),
    }, sidecar.curatorState)
  })
  installProjection(ctx)

  installMemoryCommand(ctx, store, {
    triggerReview: (agent, focus) => { reviewControl?.triggerNow(agent, focus) },
    listSkills: () => skillAdmin.list(),
    runCompact: (agent, signal) => runCompact(ctx, { store, configSource }, agent, signal),
    curatorRun: async () => {
      if (curatorControl === undefined) return 'The curator is not wired in this profile.'
      return renderCuratorOutcome(await curatorControl.triggerNow(), configSource.get().curatorConsolidate)
    },
    curatorStatus: async () => {
      if (curatorControl === undefined) return 'The curator is not wired in this profile.'
      return renderCuratorStatus(curatorControl.status(), configSource.get(), await countLibrary(skillStore, sidecar.telemetry))
    },
    pinSkill: (skillName, pinned) => skillAdmin.pin(skillName, pinned),
    adoptSkill: skillName => skillAdmin.adopt(skillName),
  })
  // Registers itself on construction; the settings page talks to it over RPC.
  new MemoryHermesGateway(ctx, store, sidecar.listRuns, skillStore, sidecar.telemetry)
}
