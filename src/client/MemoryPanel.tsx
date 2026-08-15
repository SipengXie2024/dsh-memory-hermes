/**
 * The sidebar-foot memory panel: a persistent footer action that opens a
 * fixed overlay showing MEMORY.md / USER.md entries with usage meters and
 * add / edit / delete controls. Layout and theme tokens mirror dsh's
 * CordisPanel (the shipped sidebar.footer.action occupant), restated as
 * inline styles so this bundle needs no CSS pipeline.
 */

import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { PanelFile, PanelListResult, PanelMutateOutcome } from '../gateway.js'
import type { MemoryToolArgs } from '../tool.js'
import { formatUsage } from './logic.js'

/** Business face injected by this package's register call. */
export interface MemoryPanelFace {
  listMemory: () => Promise<PanelListResult>
  mutateMemory: (op: MemoryToolArgs) => Promise<PanelMutateOutcome>
}

/** Owner share of sidebar.footer.action (wide vs 56px rail) + the face. */
export type MemoryPanelProps = { wide: boolean } & MemoryPanelFace

const styles = {
  layer: { position: 'relative', flex: 'none', display: 'flex', alignItems: 'center', width: '100%', height: 49, margin: '8px 0 0' },
  layerRail: { position: 'relative', flex: 'none', display: 'flex', alignItems: 'center', width: 36, height: 36, margin: 0 },
  badge: {
    display: 'inline-flex', alignItems: 'center', gap: 8, width: '100%', height: 49,
    padding: '0 8px 0 6px', border: 'none', borderRadius: 12, background: 'transparent',
    color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit', fontSize: 14, cursor: 'pointer', overflow: 'hidden',
  },
  badgeRail: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36,
    padding: 0, border: 'none', borderRadius: '50%', background: 'transparent',
    color: 'var(--dsw-alias-label-primary)', cursor: 'pointer',
  },
  panel: {
    position: 'fixed', left: 12, bottom: 128, zIndex: 30, display: 'flex', flexDirection: 'column',
    width: 420, maxWidth: 'calc(100vw - 24px)', maxHeight: '60vh', overflow: 'hidden',
    border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 12,
    background: 'var(--dsw-alias-bg-base)', boxShadow: 'var(--dsw-shadow-lv2)',
  },
  header: {
    flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    minHeight: 44, padding: '10px 12px', boxSizing: 'border-box',
    borderBottom: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)',
  },
  title: { fontSize: 13, fontWeight: 500, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' },
  body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 12px 12px' },
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

function MemoryIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3 3.5C3 2.7 3.7 2 4.5 2H12a1 1 0 0 1 1 1v9.3a1 1 0 0 1-1 1H4.8A1.8 1.8 0 0 0 3 14.5V3.5Z"
        stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"
      />
      <path d="M3 12.4c0-1 .8-1.8 1.8-1.8H13" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6 5.5h4M6 7.8h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

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

/** Render the footer trigger and the overlay panel. */
export function MemoryPanel({ wide, listMemory, mutateMemory }: MemoryPanelProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<PanelListResult | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<(EntryRef & { draft: string }) | undefined>(undefined)
  const [confirming, setConfirming] = useState<EntryRef | undefined>(undefined)
  const [addDrafts, setAddDrafts] = useState<Record<string, string>>({})

  const refresh = useCallback(async () => {
    try {
      setLoadError(undefined)
      setData(await listMemory())
    } catch (error) {
      setLoadError(errorMessage(error))
    }
  }, [listMemory])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

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
    <div style={wide ? styles.layer : styles.layerRail}>
      {open && (
        <section style={styles.panel} aria-label="Persistent memory">
          <header style={styles.header}>
            <span style={styles.title}>Memory</span>
            <button type="button" style={styles.miniButton} disabled={busy} onClick={() => { void refresh() }}>Refresh</button>
          </header>
          <div style={styles.body}>
            {loadError !== undefined && <p style={styles.errorText}>{loadError}</p>}
            {actionError !== undefined && <p style={styles.errorText}>{actionError}</p>}
            {data === undefined && loadError === undefined && <p style={styles.note}>Loading&hellip;</p>}
            {data?.files.map(file => (
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
        </section>
      )}
      <button
        type="button"
        style={wide ? styles.badge : styles.badgeRail}
        aria-label="Persistent memory"
        aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}
      >
        <MemoryIcon size={wide ? 16 : 18} />
        {wide && <span>Memory</span>}
      </button>
    </div>
  )
}
