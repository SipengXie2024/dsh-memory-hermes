import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { adoptSkillText, isCuratorManaged, parseFrontmatter, renderSkillFile } from '../src/skills/provenance.js'
import { CuratorSkillStore } from '../src/skills/store.js'
import { ForkSkillTools } from '../src/skills/tools.js'

let dir: string
let store: CuratorSkillStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-skill-store-'))
  store = new CuratorSkillStore({ root: join(dir, 'skills'), maxFileBytes: 4096 })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const skillFile = (name: string) => readFileSync(join(dir, 'skills', name, 'SKILL.md'), 'utf8')

describe('provenance', () => {
  it('round-trips frontmatter with the curator marker', () => {
    const text = renderSkillFile({ name: 'a-skill', description: 'one line', createdBy: 'agent' }, '# Body\n')
    const { meta, body } = parseFrontmatter(text)
    expect(meta).toEqual({ name: 'a-skill', description: 'one line', createdBy: 'agent' })
    expect(body.trimStart()).toBe('# Body\n')
    expect(isCuratorManaged(text)).toBe(true)
  })

  it('unmarked or markerless files are not curator-managed', () => {
    expect(isCuratorManaged('# plain markdown\n')).toBe(false)
    expect(isCuratorManaged(renderSkillFile({ name: 'x', description: 'y' }, 'body'))).toBe(false)
    expect(isCuratorManaged('---\ncreated_by: user\n---\nbody')).toBe(false)
  })

  it('adoptSkillText adds the marker without touching foreign frontmatter keys', () => {
    const original = '---\nname: mine\ndescription: hand made\ndisable-model-invocation: true\n---\n# Body\n'
    const adopted = adoptSkillText(original)
    expect(isCuratorManaged(adopted)).toBe(true)
    expect(adopted).toContain('disable-model-invocation: true')
    expect(adopted).toContain('# Body')
    // An existing created_by is overwritten, not duplicated.
    const reAdopted = adoptSkillText('---\nname: x\ncreated_by: user\n---\nbody')
    expect(isCuratorManaged(reAdopted)).toBe(true)
    expect(reAdopted.match(/created_by/g)).toHaveLength(1)
    // A bare markdown file gets a minimal frontmatter block.
    const bare = adoptSkillText('# just markdown\n')
    expect(isCuratorManaged(bare)).toBe(true)
    expect(bare).toContain('# just markdown')
  })
})

describe('CuratorSkillStore.create', () => {
  it('creates the skeleton with marker and support dirs', async () => {
    await store.create('my-skill', 'one line', '# My Skill\n')
    const text = skillFile('my-skill')
    expect(text).toContain('name: my-skill')
    expect(text).toContain('description: one line')
    expect(text).toContain('created_by: agent')
    expect(text).toContain('# My Skill')
  })

  it('refuses an existing name and a bad name', async () => {
    await store.create('taken', 'd', '# body\n')
    await expect(store.create('taken', 'd2', '# other\n')).rejects.toThrow(/already exists/)
    await expect(store.create('Not Kebab', 'd', '# body\n')).rejects.toThrow(/kebab-case/)
  })
})

describe('CuratorSkillStore.list', () => {
  it('discovers skills with description and provenance', async () => {
    await store.create('curator-skill', 'made by fork', '# a\n')
    const userDir = join(dir, 'skills', 'user-skill')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, 'SKILL.md'), '---\nname: user-skill\ndescription: hand written\n---\n# hand\n')
    const list = await store.list()
    expect(list.map(skill => skill.name).sort()).toEqual(['curator-skill', 'user-skill'])
    expect(list.find(skill => skill.name === 'curator-skill')?.curatorManaged).toBe(true)
    expect(list.find(skill => skill.name === 'user-skill')?.curatorManaged).toBe(false)
  })

  it('ignores skills nested below depth 1 (dsh discovery depth)', async () => {
    const nested = join(dir, 'skills', 'category', 'nested-skill')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'SKILL.md'), '---\nname: nested-skill\ndescription: nested\n---\n')
    const list = await store.list()
    expect(list.map(skill => skill.name)).not.toContain('nested-skill')
  })

  it('follows junction/symlink skill dirs (users link skills in)', async () => {
    const target = join(dir, 'elsewhere', 'linked-skill')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'SKILL.md'), '---\nname: linked-skill\ndescription: linked in\n---\n')
    mkdirSync(join(dir, 'skills'), { recursive: true })
    symlinkSync(target, join(dir, 'skills', 'linked-skill'), 'junction')
    const list = await store.list()
    expect(list.map(skill => skill.name)).toContain('linked-skill')
  })
})

describe('CuratorSkillStore mutations', () => {
  it('edit rewrites the body and preserves the marker and description', async () => {
    await store.create('evolving', 'original desc', '# v1\n')
    await store.edit('evolving', '# v2\n')
    const text = skillFile('evolving')
    expect(text).toContain('# v2')
    expect(text).toContain('created_by: agent')
    expect(text).toContain('description: original desc')
  })

  it('patch replaces exactly-once matches and refuses zero/multi matches', async () => {
    await store.create('patchable', 'd', 'alpha beta gamma beta\n')
    await expect(store.patch('patchable', undefined, 'zzz', 'x')).rejects.toThrow(/matches nothing/)
    await expect(store.patch('patchable', undefined, 'beta', 'x')).rejects.toThrow(/more than once/)
    await store.patch('patchable', undefined, 'beta gamma', 'DELTA')
    expect(skillFile('patchable')).toContain('alpha DELTA beta')
  })

  it('write_file and remove_file manage support files under the four dirs', async () => {
    await store.create('documented', 'd', '# doc\n')
    await store.writeFile('documented', 'references/notes.md', 'note body')
    expect(readFileSync(join(dir, 'skills', 'documented', 'references', 'notes.md'), 'utf8')).toBe('note body')
    await store.removeFile('documented', 'references/notes.md')
    const view = await store.view('documented', 'references/notes.md').catch((error: Error) => error)
    expect((view as Error).message).toContain('not found')
  })

  it('refuses support paths outside the four dirs or escaping the skill dir', async () => {
    await store.create('sandboxed', 'd', '# s\n')
    await expect(store.writeFile('sandboxed', 'secrets.txt', 'x')).rejects.toThrow(/must start with/)
    await expect(store.writeFile('sandboxed', 'references/../../escape.md', 'x')).rejects.toThrow()
  })

  it('enforces the byte cap', async () => {
    await store.create('capped', 'd', '# c\n')
    await expect(store.writeFile('capped', 'references/big.md', 'x'.repeat(5000))).rejects.toThrow(/cap/)
  })

  it('delete removes a curator skill and refuses user-owned skills', async () => {
    await store.create('deletable', 'd', '# d\n')
    await store.delete('deletable')
    await expect(store.view('deletable')).rejects.toThrow(/not found/)
    const userDir = join(dir, 'skills', 'protected-skill')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, 'SKILL.md'), '# hand written, no marker\n')
    await expect(store.delete('protected-skill')).rejects.toThrow(/not curator-managed/)
    await expect(store.patch('protected-skill', undefined, 'hand', 'x')).rejects.toThrow(/not curator-managed/)
  })

  it('adopt transfers a user-owned skill and unlocks mutations', async () => {
    const userDir = join(dir, 'skills', 'handover')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, 'SKILL.md'), '---\nname: handover\ndescription: was mine\n---\n# body\n')
    await store.adopt('handover')
    expect(skillFile('handover')).toContain('created_by: agent')
    expect(skillFile('handover')).toContain('description: was mine')
    await store.edit('handover', '# curator can now edit\n')
    expect(skillFile('handover')).toContain('# curator can now edit')
    // Idempotence guard: adopting twice is an explicit error, not a rewrite.
    await expect(store.adopt('handover')).rejects.toThrow(/already curator-managed/)
    await expect(store.adopt('never-existed')).rejects.toThrow(/not found/)
  })
})

describe('ForkSkillTools mutation hooks', () => {
  it('fires onCreate/onDelete after the store operation succeeded, not on refusals', async () => {
    const created: string[] = []
    const deleted: string[] = []
    const tools = new ForkSkillTools(store, {
      onCreate: (name) => { created.push(name) },
      onDelete: (name) => { deleted.push(name) },
    })
    await tools.execute('skill_manage', JSON.stringify({ action: 'create', name: 'hooked', description: 'd', content: '# b\n' }))
    expect(created).toEqual(['hooked'])
    // Refused delete (read-before-write) must not fire the hook.
    const refused = await tools.execute('skill_manage', JSON.stringify({ action: 'delete', name: 'hooked' }))
    expect(refused.isError).toBe(true)
    expect(deleted).toEqual([])
    await tools.execute('skill_view', JSON.stringify({ name: 'hooked' }))
    await tools.execute('skill_manage', JSON.stringify({ action: 'delete', name: 'hooked' }))
    expect(deleted).toEqual(['hooked'])
  })

  it('remove_file fires neither hook (the skill itself remains)', async () => {
    const created: string[] = []
    const deleted: string[] = []
    const tools = new ForkSkillTools(store, {
      onCreate: (name) => { created.push(name) },
      onDelete: (name) => { deleted.push(name) },
    })
    await tools.execute('skill_manage', JSON.stringify({ action: 'create', name: 'files', description: 'd', content: '# b\n' }))
    await tools.execute('skill_view', JSON.stringify({ name: 'files' }))
    await tools.execute('skill_manage', JSON.stringify({ action: 'write_file', name: 'files', file_path: 'references/a.md', content: 'x' }))
    await tools.execute('skill_manage', JSON.stringify({ action: 'remove_file', name: 'files', file_path: 'references/a.md' }))
    expect(created).toEqual(['files'])
    expect(deleted).toEqual([])
  })
})

describe('ForkSkillTools guards', () => {
  it('patch requires a prior skill_view of the exact target', async () => {
    await store.create('guarded', 'd', 'old text\n')
    const tools = new ForkSkillTools(store)
    const refused = await tools.execute('skill_manage', JSON.stringify({ action: 'patch', name: 'guarded', find: 'old', replace: 'new' }))
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('read-before-write')
    expect(tools.counts.patched).toBe(0)

    await tools.execute('skill_view', JSON.stringify({ name: 'guarded' }))
    const allowed = await tools.execute('skill_manage', JSON.stringify({ action: 'patch', name: 'guarded', find: 'old', replace: 'new' }))
    expect(allowed.isError).toBe(false)
    expect(tools.counts.patched).toBe(1)
    expect(skillFile('guarded')).toContain('new text')
  })

  it('write_file requires reading the umbrella SKILL.md first', async () => {
    await store.create('umbrella', 'd', '# u\n')
    const tools = new ForkSkillTools(store)
    const refused = await tools.execute('skill_manage', JSON.stringify({ action: 'write_file', name: 'umbrella', file_path: 'references/a.md', content: 'x' }))
    expect(refused.isError).toBe(true)
    await tools.execute('skill_view', JSON.stringify({ name: 'umbrella' }))
    const allowed = await tools.execute('skill_manage', JSON.stringify({ action: 'write_file', name: 'umbrella', file_path: 'references/a.md', content: 'x' }))
    expect(allowed.isError).toBe(false)
    expect(tools.counts.filesWritten).toBe(1)
  })

  it('user-owned skills are refused even after being viewed', async () => {
    const userDir = join(dir, 'skills', 'mine')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, 'SKILL.md'), '# mine\n')
    const tools = new ForkSkillTools(store)
    await tools.execute('skill_view', JSON.stringify({ name: 'mine' }))
    const refused = await tools.execute('skill_manage', JSON.stringify({ action: 'edit', name: 'mine', content: '# hijacked\n' }))
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('not curator-managed')
    expect(skillFile('mine')).toBe('# mine\n')
  })

  it('create works without any prior read and counts skills in touch order', async () => {
    const tools = new ForkSkillTools(store)
    await tools.execute('skill_manage', JSON.stringify({ action: 'create', name: 'first-one', description: 'd', content: '# 1\n' }))
    await tools.execute('skill_manage', JSON.stringify({ action: 'create', name: 'second-one', description: 'd', content: '# 2\n' }))
    expect(tools.counts.created).toBe(2)
    expect(tools.counts.skills).toEqual(['first-one', 'second-one'])
  })

  it('malformed arguments and unknown actions fail as data', async () => {
    const tools = new ForkSkillTools(store)
    expect((await tools.execute('skills_list', '{nope')).isError).toBe(true)
    const unknown = await tools.execute('skill_manage', JSON.stringify({ action: 'frobnicate', name: 'x' }))
    expect(unknown.isError).toBe(true)
    expect(unknown.text).toContain('unknown skill_manage action')
  })
})
