'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useT } from '@/components/marketing/lang-provider'
import type { TemplateRow } from '@/lib/marketing/templates'

const PLACEHOLDERS = ['{name}', '{setter}', '{when}'] as const
const btn = 'rounded-lg border px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50'

/** A sample lead for the preview in the box. */
const preview = (text: string) => text.replace(/\{name\}/g, 'Marco').replace(/\{setter\}/g, 'Cristina').replace(/\{when\}/g, 'Tue 27 Oct 11:00')

/** The Templates screen (round 2 step 4). The owner creates, edits, resets and deletes; everyone else only reads. Every server answer is shown as the server wrote it (R099). */
export function TemplatesManager({ rows, canEdit }: { rows: TemplateRow[]; canEdit: boolean }) {
  const t = useT()
  const router = useRouter()
  const [editing, setEditing] = useState<{ key: string | null; label: string; it: string; en: string; orig: { label: string; it: string; en: string } } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sure, setSure] = useState<string | null>(null)
  const focus = useRef<'it' | 'en'>('it')
  const itRef = useRef<HTMLTextAreaElement>(null)
  const enRef = useRef<HTMLTextAreaElement>(null)

  const call = async (body: object): Promise<boolean> => {
    setBusy(true); setError('')
    try {
      const res = await fetch('/api/marketing/templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || t('Could not save. Please try again.')) }
      router.refresh()
      return true
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t('Could not save. Please try again.'))
      return false
    } finally { setBusy(false) }
  }

  const save = async () => {
    if (!editing) return
    // an existing template sends only what the owner CHANGED: a field left alone keeps following the built-in wording
    const body = editing.key === null
      ? { action: 'save', label: editing.label, it: editing.it, en: editing.en }
      : { action: 'save', key: editing.key, ...(editing.label !== editing.orig.label ? { label: editing.label } : {}), ...(editing.it !== editing.orig.it ? { it: editing.it } : {}), ...(editing.en !== editing.orig.en ? { en: editing.en } : {}) }
    if (editing.key !== null && Object.keys(body).length === 2) { setEditing(null); return }
    const ok = await call(body)
    if (ok) setEditing(null)
  }
  const insert = (ph: string) => {
    if (!editing) return
    const field = focus.current
    const el = field === 'it' ? itRef.current : enRef.current
    const cur = editing[field]
    const at = el?.selectionStart ?? cur.length
    setEditing({ ...editing, [field]: cur.slice(0, at) + ph + cur.slice(at) })
  }
  const ready = !!editing && editing.label.trim() !== '' && (editing.it.trim() !== '' || editing.en.trim() !== '') && !busy

  return (
    <div className="space-y-3">
      {!canEdit && <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="tpl-readonly">{t('Only the team owner can create or change templates. You can read and use them.')}</p>}
      <section className="rounded-xl border bg-white p-4">
        <div className="flex items-center justify-between">
          <b className="text-sm">{t('{n} templates', { n: rows.length })}</b>
          {canEdit && <button type="button" className={`${btn} bg-slate-900 text-white hover:bg-slate-800`} data-testid="tpl-new" onClick={() => { setError(''); setEditing({ key: null, label: '', it: '', en: '', orig: { label: '', it: '', en: '' } }) }}>{t('+ New template')}</button>}
        </div>
        <ul className="mt-2 divide-y">
          {rows.map(r => (
            <li key={r.key} className="flex items-start justify-between gap-4 py-3" data-testid="tpl-row" data-key={r.key}>
              <div className="min-w-0">
                <b className="text-sm">{r.label}</b>
                <span className="ml-2 rounded-full border px-2 py-0.5 text-[11px] text-slate-500">{r.builtIn ? (r.edited ? t('built-in, edited') : t('built-in')) : t('yours')}</span>
                {r.it && <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600"><span className="mr-1 text-[11px] font-semibold text-slate-400">IT</span>{r.it}</p>}
                {r.en && <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600"><span className="mr-1 text-[11px] font-semibold text-slate-400">EN</span>{r.en}</p>}
              </div>
              {canEdit && (
                <div className="flex shrink-0 gap-2">
                  <button type="button" className={btn} data-testid="tpl-edit" onClick={() => { setError(''); setEditing({ key: r.key, label: r.label, it: r.it, en: r.en, orig: { label: r.label, it: r.it, en: r.en } }) }}>{t('Edit')}</button>
                  {r.builtIn && r.edited && <button type="button" className={btn} disabled={busy} data-testid="tpl-reset" onClick={async () => { if (await call({ action: 'reset', key: r.key })) setError('') }}>{t('Reset to original')}</button>}
                  {!r.builtIn && (sure === r.key
                    ? <button type="button" className={`${btn} border-red-300 text-red-700`} disabled={busy} data-testid="tpl-delete-sure" onClick={async () => { if (await call({ action: 'delete', key: r.key })) setSure(null) }}>{t('Yes, delete')}</button>
                    : <button type="button" className={btn} data-testid="tpl-delete" onClick={() => setSure(r.key)}>{t('Delete')}</button>)}
                </div>
              )}
            </li>
          ))}
        </ul>
        {error && !editing && <p role="alert" className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800" data-testid="tpl-error">{error}</p>}
      </section>

      {editing && (
        <div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={editing.key ? t('Edit template') : t('New template')} data-testid="tpl-dialog">
          <div className="max-h-[92vh] w-full max-w-lg space-y-3 overflow-auto rounded-xl bg-white p-5 shadow-2xl">
            <h2 className="text-base font-semibold">{editing.key ? t('Edit template') : t('New template')}</h2>
            <label className="block text-xs text-slate-600">{t('Name (what people see in the list)')}
              <input value={editing.label} onChange={e => setEditing({ ...editing, label: e.target.value })} maxLength={80} data-testid="tpl-name" className="mt-1 w-full rounded-lg border px-2 py-1.5 text-sm" />
            </label>
            <label className="block text-xs text-slate-600">{t('Italian text')}
              <textarea ref={itRef} value={editing.it} onFocus={() => { focus.current = 'it' }} onChange={e => setEditing({ ...editing, it: e.target.value })} rows={4} maxLength={4000} data-testid="tpl-it" className="mt-1 w-full rounded-lg border px-2 py-1.5 text-sm" />
            </label>
            <label className="block text-xs text-slate-600">{t('English text')}
              <textarea ref={enRef} value={editing.en} onFocus={() => { focus.current = 'en' }} onChange={e => setEditing({ ...editing, en: e.target.value })} rows={4} maxLength={4000} data-testid="tpl-en" className="mt-1 w-full rounded-lg border px-2 py-1.5 text-sm" />
            </label>
            <p className="text-xs text-slate-500">{t('Click to add a placeholder; the system fills it in for each lead:')} {PLACEHOLDERS.map(p => <button key={p} type="button" onClick={() => insert(p)} className="mr-1.5 rounded-md border px-2 py-0.5 text-xs hover:bg-slate-50">{p}</button>)}</p>
            <div className="rounded-lg bg-slate-100 p-2.5 text-sm">
              <p className="text-xs text-slate-500">{t('Preview for the sample lead "Marco Bianchi"')}</p>
              <p className="mt-1 whitespace-pre-wrap" data-testid="tpl-preview">{preview(editing.it || editing.en)}</p>
            </div>
            {error && <p role="alert" className="text-sm text-red-700" data-testid="tpl-error">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className={btn} onClick={() => setEditing(null)}>{t('Cancel')}</button>
              <button type="button" className={`${btn} bg-slate-900 text-white hover:bg-slate-800`} disabled={!ready} onClick={save} data-testid="tpl-save">{busy ? t('Saving…') : t('Save template')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
