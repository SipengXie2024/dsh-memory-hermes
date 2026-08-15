/**
 * Browser bundle for the web memory panel, in dsh's closure-factory shape:
 * the artifact calls window.__ModuleLoader__.load({id, factory}) and resolves
 * externals through the injected require (the loader's frozen module table).
 * Vendored from dsh packages/client/tsdown.client.ts (rc.6), minus the CSS
 * pipeline (this panel styles inline) and the workspace build-face plumbing.
 */
import { defineConfig } from 'tsdown'

/** dsh PLATFORM_MODULES + the documented runtime store exemption — the exact
 * loader module-table keys; anything else must inline. */
const CLIENT_EXTERNALS: readonly string[] = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

const ID = 'dsh-memory-hermes'

export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'dist',
  format: 'cjs',
  platform: 'browser',
  // Types ship from tsc; dts here would wrap the banner/footer and break parsing.
  dts: false,
  sourcemap: true,
  // The node half already lives in dist/ (tsc); a default clean would wipe it.
  clean: false,
  external: [...CLIENT_EXTERNALS],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  // Bundle everything the module table cannot answer (a require() miss is a
  // guaranteed runtime throw); table entries stay external.
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  plugins: [{
    // Purity gate, stricter than dsh's own: this plugin's client half has no
    // business value-importing ANY @deepseek-ai package outside the table
    // (type-only imports are erased and never reach resolveId).
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if (CLIENT_EXTERNALS.includes(source)) return null
      throw new Error(
        `client bundle purity: value import of "${source}" is not in the loader module table; `
        + 'use an import type or collaborate through a cordis service',
      )
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
