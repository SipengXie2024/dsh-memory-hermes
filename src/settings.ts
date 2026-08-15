/**
 * Live configuration source. When the host composes the `settings` service,
 * the plugin's tunables become a settings namespace whose user layer sits
 * above the bundle-patch `base`; without it (headless, minimal profiles)
 * the Loader entry config stands alone.
 *
 * Registration rides an inject scope: the settings service may not be up
 * yet when this plugin's apply() runs (row order is not service-readiness
 * order), so a one-shot ctx.get() at apply time could fall back
 * permanently. The facade always answers and swaps in the real scope when
 * the service appears; facade watchers keep working across the swap and
 * are notified once with the scope's resolved value.
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

export function createConfigSource(
  ctx: Context,
  loaderConfig: Resolved,
  schema: unknown,
  warn: (message: string) => void,
): ConfigSource {
  const listeners = new Set<(next: Resolved, prev: Resolved) => void>()
  const state: { source: ConfigSource } = { source: fixedConfigSource(loaderConfig) }
  const facade: ConfigSource = {
    get: () => state.source.get(),
    watch: (callback) => {
      listeners.add(callback)
      return () => { listeners.delete(callback) }
    },
  }
  ctx.inject(['settings'], (scoped) => {
    const settings = scoped.get('settings') as SettingsLike | undefined
    if (settings === undefined || typeof settings.register !== 'function') return
    try {
      // The scope resolves schema defaults <- base <- user layer; get()
      // always returns a fully-defaulted value, hence the Resolved cast.
      const scope = settings.register('memory-hermes', schema, { base: loaderConfig, applies: 'live' })
      const previous = state.source.get()
      state.source = {
        get: () => scope.get() as Resolved,
        watch: (callback) => scope.watch(callback as (next: never, prev: never) => void),
      }
      scope.watch(((next: Resolved, prev: Resolved) => {
        for (const callback of listeners) callback(next, prev)
      }) as (next: never, prev: never) => void)
      // Notify once so consumers (store limits, review policy) pick up any
      // user-layer override the fixed source did not know about. Watchers
      // are idempotent setters, so an unchanged value is harmless.
      for (const callback of listeners) callback(state.source.get(), previous)
    } catch (error) {
      // A stored user section that fails the schema rejects registration;
      // fall back to the composition layer rather than bricking the plugin.
      warn(`memory-hermes: settings namespace unavailable, using composition config: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  return facade
}
