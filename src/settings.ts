/**
 * Live configuration source. When the host composes the `settings` service,
 * the plugin's tunables become a GUI-editable namespace whose user layer sits
 * above the bundle-patch `base`; without it (headless, minimal profiles) the
 * Loader entry config stands alone. Everything downstream reads through
 * ConfigSource.get() so a `settings/updated` commit takes effect without a
 * restart — the scope's watch() feeds store limits and review policy.
 *
 * @module dsh-memory-hermes/settings
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Resolved } from './config.js'

/** Uniform read face over a settings scope or a fixed loader config. */
export interface ConfigSource {
  get(): Resolved
  /** Observe committed changes; the fixed source never fires. */
  watch(callback: (next: Resolved, prev: Resolved) => void): () => void
}

export function fixedConfigSource(resolved: Resolved): ConfigSource {
  return { get: () => resolved, watch: () => () => {} }
}

/** Structural view of the settings service registration seam. */
interface SettingsLike {
  register(
    ns: string,
    schema: unknown,
    options: { base: object; applies: 'live' | 'restart' },
  ): { get(): unknown; watch(callback: (next: never, prev: never) => void): () => void }
}

export function resolveConfigSource(
  ctx: Context,
  loaderConfig: Resolved,
  schema: unknown,
  warn: (message: string) => void,
): ConfigSource {
  const settings = ctx.get('settings') as SettingsLike | undefined
  if (settings === undefined || typeof settings.register !== 'function') {
    return fixedConfigSource(loaderConfig)
  }
  try {
    // The scope resolves schema defaults <- base <- user layer; get() always
    // returns a fully-defaulted value, hence the Resolved cast.
    const scope = settings.register('memory-hermes', schema, { base: loaderConfig, applies: 'live' })
    return {
      get: () => scope.get() as Resolved,
      watch: (callback) => scope.watch(callback as (next: never, prev: never) => void),
    }
  } catch (error) {
    // A stored user section that fails the schema rejects registration; fall
    // back to the composition layer rather than bricking the plugin.
    warn(`memory-hermes: settings namespace unavailable, using composition config: ${error instanceof Error ? error.message : String(error)}`)
    return fixedConfigSource(loaderConfig)
  }
}
