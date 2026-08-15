import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const bundlePath = join(import.meta.dirname, '..', 'dist', 'client.js')

// Runs only after `npm run build`; vitest alone must stay green on a clean tree.
describe.skipIf(!existsSync(bundlePath))('client bundle smoke', () => {
  const source = () => readFileSync(bundlePath, 'utf8')

  it('is a closure-factory artifact for the module loader', () => {
    const text = source()
    expect(text).toContain('window.__ModuleLoader__.load(')
    expect(text).toContain('"dsh-memory-hermes"')
    expect(text).toContain('factory: (require) =>')
    expect(text).toContain('var module = { exports: {} }')
    expect(text).toContain('return module.exports;')
  })

  it('resolves only module-table externals through require', () => {
    const required = [...source().matchAll(/require\("([^"]+)"\)/g)].map(match => match[1])
    expect(required.length).toBeGreaterThan(0)
    for (const specifier of required) {
      expect(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']).toContain(specifier)
    }
    // Purity: nothing under @deepseek-ai may be required OR inlined by value.
    expect(source()).not.toContain('require("@deepseek-ai')
  })
})
