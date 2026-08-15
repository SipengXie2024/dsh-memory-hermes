/**
 * The memory settings page: a settings.section entry showing MEMORY.md /
 * USER.md entries with usage meters and add / edit / delete controls.
 * Theme tokens mirror dsh's shipped settings pages, restated as inline
 * styles so this bundle needs no CSS pipeline.
 */

import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { PanelFile, PanelListResult, PanelMutateOutcome, PanelReviewRun, PanelReviewRunsResult, PanelSkill, PanelSkillsResult } from '../gateway.js'
import type { MemoryToolArgs } from '../tool.js'
import { cleanErrorMessage, formatDuration, formatUsage, summarizeRun } from './logic.js'

/** Business face injected by this package's register call. */
export interface MemoryPanelFace {
  listMemory: () => Promise<PanelListResult>
  mutateMemory: (op: MemoryToolArgs) => Promise<PanelMutateOutcome>
  listReviewRuns: () => Promise<PanelReviewRunsResult>
  listSkills: () => Promise<PanelSkillsResult>
}

/** The thunk closes over the face; settings.section's only owner prop is
 * `close`, which this page never uses. */
export type MemoryPanelProps = MemoryPanelFace

const styles = {
  page: {
    display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 640,
    fontSize: 12, color: 'var(--dsw-alias-label-secondary)',
  },
  header: {
    flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    minHeight: 32, boxSizing: 'border-box',
  },
  tabRow: { display: 'flex', gap: 6, alignItems: 'center' },
  tab: {
    padding: '0 10px', height: 22, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 999,
    background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', font: 'inherit', fontSize: 11, cursor: 'pointer',
  },
  tabActive: {
    padding: '0 10px', height: 22, border: '1px solid var(--dsw-alias-label-tertiary)', borderRadius: 999,
    background: 'transparent', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 11, cursor: 'pointer',
  },
  runRow: {
    padding: '6px 8px', borderRadius: 8, margin: '4px 0',
    border: '1px solid var(--dsw-alias-border-l2)',
  },
  runMeta: { display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
  runEntries: { margin: '4px 0 0', paddingLeft: 16, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
  title: { fontSize: 13, fontWeight: 500, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' },
  body: { display: 'flex', flexDirection: 'column' },
  note: { margin: '4px 0', fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  errorText: { margin: '4px 0', fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  group: {
    margin: '10px 0 2px', fontSize: 11, fontWeight: 500, lineHeight: '16px',
    color: 'var(--dsw-alias-label-caption)', textTransform: 'uppercase', letterSpacing: '0.04em',
    display: 'flex', alignItems: 'baseline', gap: 8,
  },
  usageText: { fontSize: 11, fontWeight: 400, textTransform: 'none', letterSpacing: 'normal', color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums' },
  meter: { height: 3, margin: '4px 0 6px', borderRadius: 2, background: 'var(--dsw-alias-button-ghost-active-fill)', overflow: 'hidden' },
  entryList: { display: 'flex', flexDirection: 'column', gap: 2, margin: 0, padding: 0, listStyle: 'none' },
  entry: {
    display: 'flex', alignItems: 'flex-start', gap: 6, padding: '4px 6px', borderRadius: 8,
    fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)',
  },
  entryText: { flex: 1, minWidth: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  entryActions: { flex: 'none', display: 'flex', gap: 4 },
  miniButton: {
    padding: '0 6px', height: 20, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 999,
    background: 'transparent', color: 'var(--dsw-alias-label-secondary)', font: 'inherit', fontSize: 11,
    lineHeight: '18px', cursor: 'pointer',
  },
  miniDanger: {
    padding: '0 6px', height: 20, border: '1px solid var(--dsw-alias-state-error-primary)', borderRadius: 999,
    background: 'transparent', color: 'var(--dsw-alias-state-error-primary)', font: 'inherit', fontSize: 11,
    lineHeight: '18px', cursor: 'pointer',
  },
  editArea: {
    width: '100%', boxSizing: 'border-box', margin: '4px 0', padding: '6px 8px',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
    font: 'inherit', fontSize: 12, lineHeight: '18px', resize: 'vertical',
  },
  addRow: { display: 'flex', gap: 6, margin: '6px 0 2px' },
  addInput: {
    flex: 1, minWidth: 0, height: 26, padding: '0 8px', boxSizing: 'border-box',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 7,
    background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 12,
  },
} satisfies Record<string, CSSProperties>

function FlagIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" fill="none" aria-hidden style={{ flex: 'none', marginTop: 3, color: 'var(--dsw-alias-state-warn-label, var(--dsw-alias-state-error-primary))' }}>
      <path d="M6 1.2 11 10H1L6 1.2Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M6 4.4v2.6M6 8.4v.2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface EntryRef {
  file: string
  target: string
}

const sameRef = (a: EntryRef | undefined, b: EntryRef): boolean =>
  a !== undefined && a.file === b.file && a.target === b.target

/** One memory file section: heading, usage meter, entries, and the add row. */
function FileSection({ file, busy, editing, confirming, onEdit, onDraft, onSave, onCancelEdit, onAskDelete, onDelete, onCancelDelete, addDraft, onAddDraft, onAdd }: {
  file: PanelFile
  busy: boolean
  editing: (EntryRef & { draft: string }) | undefined
  confirming: EntryRef | undefined
  onEdit: (ref: EntryRef) => void
  onDraft: (draft: string) => void
  onSave: () => void
  onCancelEdit: () => void
  onAskDelete: (ref: EntryRef) => void
  onDelete: (ref: EntryRef) => void
  onCancelDelete: () => void
  addDraft: string
  onAddDraft: (draft: string) => void
  onAdd: () => void
}): ReactNode {
  const meterColor = file.percent >= 90
    ? 'var(--dsw-alias-state-error-primary)'
    : 'var(--dsw-alias-state-business-primary, var(--dsw-alias-label-tertiary))'
  return (
    <section>
      <h3 style={styles.group}>
        <span>{file.label}</span>
        <span style={styles.usageText}>
          {`${formatUsage(file.chars, file.limit, file.percent)}, ${file.entries.length} ${file.entries.length === 1 ? 'entry' : 'entries'}`}
        </span>
      </h3>
      <div style={styles.meter} aria-hidden>
        <div style={{ width: `${Math.min(100, file.percent)}%`, height: '100%', background: meterColor }} />
      </div>
      {file.readError !== undefined && <p style={styles.errorText}>{`read error: ${file.readError}`}</p>}
      {file.readError === undefined && file.entries.length === 0 && <p style={styles.note}>No entries yet.</p>}
      <ul style={styles.entryList}>
        {file.entries.map((entry, index) => {
          const ref: EntryRef = { file: file.key, target: entry.text }
          const isEditing = editing !== undefined && sameRef(editing, ref)
          const isConfirming = sameRef(confirming, ref)
          return (
            <li key={`${index}-${entry.text}`} style={styles.entry}>
              {isEditing
                ? (
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <textarea
                        style={styles.editArea}
                        rows={2}
                        value={editing.draft}
                        disabled={busy}
                        onChange={(event) => { onDraft(event.target.value) }}
                      />
                      <div style={styles.entryActions}>
                        <button type="button" style={styles.miniButton} disabled={busy} onClick={onSave}>Save</button>
                        <button type="button" style={styles.miniButton} disabled={busy} onClick={onCancelEdit}>Cancel</button>
                      </div>
                    </div>
                  )
                : (
                    <>
                      {entry.flagged && (
                        <span title="The security scan would flag this content when written by the model.">
                          <FlagIcon />
                        </span>
                      )}
                      <span style={styles.entryText}>{entry.text}</span>
                      <span style={styles.entryActions}>
                        {isConfirming
                          ? (
                              <>
                                <button type="button" style={styles.miniDanger} disabled={busy} onClick={() => { onDelete(ref) }}>Confirm</button>
                                <button type="button" style={styles.miniButton} disabled={busy} onClick={onCancelDelete}>Keep</button>
                              </>
                            )
                          : (
                              <>
                                <button type="button" style={styles.miniButton} disabled={busy} onClick={() => { onEdit(ref) }}>Edit</button>
                                <button type="button" style={styles.miniButton} disabled={busy} onClick={() => { onAskDelete(ref) }}>Del</button>
                              </>
                            )}
                      </span>
                    </>
                  )}
            </li>
          )
        })}
      </ul>
      <div style={styles.addRow}>
        <input
          style={styles.addInput}
          placeholder={`Add to ${file.label}`}
          value={addDraft}
          disabled={busy}
          onChange={(event) => { onAddDraft(event.target.value) }}
          onKeyDown={(event) => { if (event.key === 'Enter') onAdd() }}
        />
        <button type="button" style={styles.miniButton} disabled={busy || addDraft.trim() === ''} onClick={onAdd}>Add</button>
      </div>
    </section>
  )
}

const KIND_LABEL: Record<PanelReviewRun['kind'], string> = { turn: '回合', compaction: '折叠收割', manual: '手动', curator: '库维护' }

/** Activity tab: one row per settled background review pass, newest first. */
function ActivitySection({ runs }: { runs: readonly PanelReviewRun[] }): ReactNode {
  if (runs.length === 0) return <p style={styles.note}>还没有 review 记录。</p>
  return (
    <div>
      {runs.map((run) => {
        const failed = run.error !== undefined
        const stepCount = run.trace?.length ?? 0
        return (
          <div key={run.id} style={styles.runRow}>
            <div style={styles.runMeta}>
              <span>{new Date(run.startedAt).toLocaleString()}</span>
              <span>{KIND_LABEL[run.kind]}</span>
              {run.turn >= 0 && <span>turn {run.turn}</span>}
              <span>{formatDuration(Math.max(0, run.settledAt - run.startedAt))}</span>
            </div>
            {failed
              ? <p style={styles.errorText}>{`失败:${cleanErrorMessage(run.error!)}`}</p>
              : <p style={styles.note}>{summarizeRun(run)}</p>}
            {run.entries !== undefined && run.entries.length > 0 && (
              <ul style={styles.runEntries}>
                {run.entries.map((entry, index) => <li key={index}>{entry}</li>)}
              </ul>
            )}
            {stepCount > 0 && (
              <details style={styles.note}>
                <summary style={{ cursor: 'pointer' }}>{`过程(${stepCount} 步)`}</summary>
                <ul style={styles.runEntries}>
                  {run.trace!.map((line, index) => <li key={index}>{line}</li>)}
                </ul>
              </details>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** Skills tab: what the background review has curated so far. */
function SkillsSection({ skills }: { skills: readonly PanelSkill[] }): ReactNode {
  if (skills.length === 0) return <p style={styles.note}>还没有沉淀的 skill——等后台 review 从对话里提炼,或用 /memory review 点名让它建。</p>
  return (
    <div>
      {skills.map(skill => (
        <div key={skill.name} style={styles.runRow}>
          <div style={styles.runMeta}>
            <span style={{ color: 'var(--dsw-alias-label-primary)', fontWeight: 500 }}>{skill.name}</span>
            {skill.pinned === true && <span>已置顶</span>}
            {skill.state === 'stale' && <span style={{ color: 'var(--dsw-alias-state-warn-label, var(--dsw-alias-state-error-primary))' }}>沉寂</span>}
            {skill.useCount !== undefined && (
              <span>
                {skill.useCount === 0 ? '没用过' : `用过 ${skill.useCount} 次`}
                {skill.lastUsedAt !== undefined && `,最近 ${new Date(skill.lastUsedAt).toLocaleDateString()}`}
              </span>
            )}
          </div>
          {skill.description !== '' && <p style={styles.note}>{skill.description}</p>}
        </div>
      ))}
    </div>
  )
}

/** The settings page body: usage meters, entries, and edit controls. */
export function MemoryPanel({ listMemory, mutateMemory, listReviewRuns, listSkills }: MemoryPanelProps): ReactNode {
  const [tab, setTab] = useState<'files' | 'skills' | 'activity'>('files')
  const [data, setData] = useState<PanelListResult | undefined>(undefined)
  const [runs, setRuns] = useState<readonly PanelReviewRun[] | undefined>(undefined)
  const [skills, setSkills] = useState<readonly PanelSkill[] | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<(EntryRef & { draft: string }) | undefined>(undefined)
  const [confirming, setConfirming] = useState<EntryRef | undefined>(undefined)
  const [addDrafts, setAddDrafts] = useState<Record<string, string>>({})

  const refresh = useCallback(async () => {
    try {
      setLoadError(undefined)
      const [filesResult, runsResult, skillsResult] = await Promise.all([listMemory(), listReviewRuns(), listSkills()])
      setData(filesResult)
      setRuns(runsResult.runs)
      setSkills(skillsResult.skills)
    } catch (error) {
      setLoadError(errorMessage(error))
    }
  }, [listMemory, listReviewRuns, listSkills])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const run = useCallback(async (op: MemoryToolArgs, onSuccess?: () => void) => {
    if (busy) return
    setBusy(true)
    setActionError(undefined)
    try {
      const outcome = await mutateMemory(op)
      if (outcome.ok) onSuccess?.()
      else setActionError(outcome.message)
    } catch (error) {
      setActionError(errorMessage(error))
    } finally {
      setBusy(false)
      void refresh()
    }
  }, [busy, mutateMemory, refresh])

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <span style={styles.title}>Memory</span>
        <span style={styles.tabRow}>
          <button type="button" style={tab === 'files' ? styles.tabActive : styles.tab} onClick={() => { setTab('files') }}>文件</button>
          <button type="button" style={tab === 'skills' ? styles.tabActive : styles.tab} onClick={() => { setTab('skills') }}>技能</button>
          <button type="button" style={tab === 'activity' ? styles.tabActive : styles.tab} onClick={() => { setTab('activity') }}>活动</button>
          <button type="button" style={styles.miniButton} disabled={busy} onClick={() => { void refresh() }}>Refresh</button>
        </span>
      </header>
      <div style={styles.body}>
        {loadError !== undefined && <p style={styles.errorText}>{loadError}</p>}
        {actionError !== undefined && <p style={styles.errorText}>{actionError}</p>}
        {tab === 'activity' && (
          runs === undefined
            ? (loadError === undefined ? <p style={styles.note}>Loading&hellip;</p> : null)
            : <ActivitySection runs={runs} />
        )}
        {tab === 'skills' && (
          skills === undefined
            ? (loadError === undefined ? <p style={styles.note}>Loading&hellip;</p> : null)
            : <SkillsSection skills={skills} />
        )}
        {tab === 'files' && data === undefined && loadError === undefined && <p style={styles.note}>Loading&hellip;</p>}
        {tab === 'files' && data?.files.map(file => (
          <FileSection
            key={file.key}
            file={file}
            busy={busy}
            editing={editing}
            confirming={confirming}
            onEdit={(ref) => {
              setConfirming(undefined)
              setEditing({ ...ref, draft: ref.target })
            }}
            onDraft={(draft) => { setEditing(current => current === undefined ? current : { ...current, draft }) }}
            onSave={() => {
              if (editing === undefined) return
              void run(
                { action: 'replace', file: editing.file, target: editing.target, new_content: editing.draft },
                () => { setEditing(undefined) },
              )
            }}
            onCancelEdit={() => { setEditing(undefined) }}
            onAskDelete={(ref) => {
              setEditing(undefined)
              setConfirming(ref)
            }}
            onDelete={(ref) => {
              void run({ action: 'remove', file: ref.file, target: ref.target }, () => { setConfirming(undefined) })
            }}
            onCancelDelete={() => { setConfirming(undefined) }}
            addDraft={addDrafts[file.key] ?? ''}
            onAddDraft={(draft) => { setAddDrafts(current => ({ ...current, [file.key]: draft })) }}
            onAdd={() => {
              const draft = (addDrafts[file.key] ?? '').trim()
              if (draft === '') return
              void run(
                { action: 'add', file: file.key, content: draft },
                () => { setAddDrafts(current => ({ ...current, [file.key]: '' })) },
              )
            }}
          />
        ))}
      </div>
    </div>
  )
}
