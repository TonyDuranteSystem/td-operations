'use client'

/**
 * TD Communication Phase 14 — Portfolio Manager (curator UI).
 *
 * Shared by the CRM dashboard "Portfolio" tab and the /collab "Portfolio" section.
 * Lists showcase entries and lets a curator create/edit them, pick before/after
 * images (upload OR from released deliverables), and — for admins — publish,
 * feature, reorder, and record a written-permission attestation.
 *
 * Consent is soft: the badge informs, it never blocks publishing. All server
 * errors are surfaced to the user (R099). canEdit gates create/edit/delete;
 * isAdmin gates publish/feature/reorder/attest (the public-facing controls).
 */

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, Plus, Star, Trash2, Eye, EyeOff, ArrowUp, ArrowDown, ShieldCheck, Upload, ImageIcon, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PortfolioEntryWithConsent } from '@/lib/td-communication/types'
import { FastTooltip } from '@/components/ui/fast-tooltip'

const API = '/api/td-communication/admin/portfolio'

interface DeliverableOption {
  id: string
  file_name: string
  preview_url: string | null
}

interface FormState {
  id: string | null
  enrollment_id: string
  title_en: string
  title_it: string
  client_name: string
  description_en: string
  description_it: string
  category: string
  tags: string
  before_image_url: string
  after_image_url: string
}

const EMPTY_FORM: FormState = {
  id: null,
  enrollment_id: '',
  title_en: '',
  title_it: '',
  client_name: '',
  description_en: '',
  description_it: '',
  category: '',
  tags: '',
  before_image_url: '',
  after_image_url: '',
}

async function errorFrom(res: Response, fallback: string): Promise<string> {
  const d = await res.json().catch(() => ({}))
  return (d && typeof d.error === 'string' && d.error) || fallback
}

const CONSENT_BADGE: Record<PortfolioEntryWithConsent['consent_state'], { label: string; cls: string }> = {
  opted_in: { label: 'Client opted in', cls: 'bg-green-50 text-green-700 border-green-200' },
  written_on_file: { label: 'Written permission', cls: 'bg-zinc-100 text-zinc-600 border-zinc-200' },
  withdrawn: { label: 'Consent withdrawn — auto-hidden', cls: 'bg-red-50 text-red-700 border-red-200' },
  none: { label: 'No consent recorded', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
}

export function PortfolioManager({ canEdit, isAdmin }: { canEdit: boolean; isAdmin: boolean }) {
  const [entries, setEntries] = useState<PortfolioEntryWithConsent[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(API)
      if (!res.ok) throw new Error(await errorFrom(res, 'Could not load the portfolio.'))
      const data = await res.json()
      setEntries(Array.isArray(data.entries) ? data.entries : [])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load the portfolio.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function save() {
    if (!form) return
    if (!form.after_image_url.trim()) {
      toast.error('A finished ("after") image is required.')
      return
    }
    setSaving(true)
    try {
      const payload = {
        enrollment_id: form.enrollment_id || null,
        title_en: form.title_en,
        title_it: form.title_it,
        client_name: form.client_name,
        description_en: form.description_en,
        description_it: form.description_it,
        category: form.category || null,
        tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
        before_image_url: form.before_image_url || null,
        after_image_url: form.after_image_url,
      }
      const res = await fetch(form.id ? `${API}/${form.id}` : API, {
        method: form.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error(await errorFrom(res, 'Could not save the entry.'))
      toast.success(form.id ? 'Entry updated.' : 'Entry created (draft).')
      setForm(null)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the entry.')
    } finally {
      setSaving(false)
    }
  }

  async function act(id: string, run: () => Promise<Response>, fallback: string, ok: string) {
    setBusyId(id)
    try {
      const res = await run()
      if (!res.ok) throw new Error(await errorFrom(res, fallback))
      toast.success(ok)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : fallback)
    } finally {
      setBusyId(null)
    }
  }

  function togglePublish(e: PortfolioEntryWithConsent) {
    return act(e.id, () => fetch(`${API}/${e.id}/state`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ published: !e.published }),
    }), 'Could not change visibility.', e.published ? 'Unpublished.' : 'Published to the public page.')
  }
  function toggleFeature(e: PortfolioEntryWithConsent) {
    return act(e.id, () => fetch(`${API}/${e.id}/state`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ featured: !e.featured }),
    }), 'Could not change featured.', e.featured ? 'Unfeatured.' : 'Featured.')
  }
  function attest(e: PortfolioEntryWithConsent) {
    return act(e.id, () => fetch(`${API}/${e.id}/attest`, { method: 'POST' }), 'Could not record the attestation.', 'Written permission recorded.')
  }
  function remove(e: PortfolioEntryWithConsent) {
    if (!confirm('Delete this portfolio entry? It will be removed from the public page.')) return Promise.resolve()
    return act(e.id, () => fetch(`${API}/${e.id}`, { method: 'DELETE' }), 'Could not delete the entry.', 'Entry deleted.')
  }
  async function move(idx: number, dir: -1 | 1) {
    const next = idx + dir
    if (next < 0 || next >= entries.length) return
    const reordered = [...entries]
    const [it] = reordered.splice(idx, 1)
    reordered.splice(next, 0, it)
    setEntries(reordered) // optimistic
    try {
      const res = await fetch(`${API}/reorder`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderedIds: reordered.map((e) => e.id) }),
      })
      if (!res.ok) throw new Error(await errorFrom(res, 'Could not reorder.'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not reorder.')
      await load()
    }
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto pr-0.5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm text-zinc-500">
          {entries.length} {entries.length === 1 ? 'entry' : 'entries'} · public page at{' '}
          <code className="text-xs bg-zinc-100 px-1 rounded">/portfolio</code>
        </p>
        {canEdit && (
          <button
            type="button"
            onClick={() => setForm({ ...EMPTY_FORM })}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" /> New entry
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-zinc-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-300 py-16 text-center">
          <ImageIcon className="h-10 w-10 text-zinc-300 mx-auto mb-3" />
          <p className="text-sm text-zinc-500">No portfolio entries yet.</p>
          {canEdit && <p className="text-xs text-zinc-400 mt-1">Click &quot;New entry&quot; to showcase a finished project.</p>}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {entries.map((e, idx) => {
            const badge = CONSENT_BADGE[e.consent_state]
            const busy = busyId === e.id
            return (
              <div key={e.id} className="rounded-xl border border-zinc-200 bg-white overflow-hidden shadow-sm flex flex-col">
                <div className="relative aspect-[4/3] bg-zinc-50 grid grid-cols-2">
                  {e.before_image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={e.before_image_url} alt="before" className="h-full w-full object-contain p-1" />
                  ) : <div className="flex items-center justify-center text-[10px] text-zinc-300">no before</div>}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={e.after_image_url} alt="after" className="h-full w-full object-contain p-1 border-l border-zinc-100" />
                  <div className="absolute top-1.5 left-1.5 flex gap-1">
                    <span className={cn('text-[10px] px-1.5 py-0.5 rounded border', e.published ? 'bg-green-600 text-white border-green-600' : 'bg-white text-zinc-500 border-zinc-200')}>
                      {e.published ? 'Public' : 'Draft'}
                    </span>
                    {e.featured && <span className="text-[10px] px-1.5 py-0.5 rounded border bg-amber-400 text-amber-950 border-amber-400">★ Featured</span>}
                  </div>
                </div>
                <div className="p-3 flex-1 flex flex-col gap-2">
                  <div>
                    <div className="text-sm font-semibold text-zinc-900 truncate">{e.title_en || e.client_name || 'Untitled'}</div>
                    {e.client_name && <div className="text-xs text-zinc-500 truncate">{e.client_name}</div>}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {e.category && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-100">{e.category}</span>}
                    {e.tags.slice(0, 4).map((t) => <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600">{t}</span>)}
                  </div>
                  <span className={cn('inline-flex w-fit items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border', badge.cls)}>
                    <ShieldCheck className="h-3 w-3" /> {badge.label}
                  </span>

                  <div className="mt-auto flex flex-wrap items-center gap-1 pt-1">
                    {canEdit && (
                      <button type="button" disabled={busy} onClick={() => setForm({
                        id: e.id, enrollment_id: e.enrollment_id ?? '', title_en: e.title_en, title_it: e.title_it,
                        client_name: e.client_name, description_en: e.description_en, description_it: e.description_it,
                        category: e.category ?? '', tags: e.tags.join(', '), before_image_url: e.before_image_url ?? '', after_image_url: e.after_image_url,
                      })} className="text-xs px-2 py-1 rounded border border-zinc-200 hover:bg-zinc-50">Edit</button>
                    )}
                    {isAdmin && (
                      <>
                        <FastTooltip label={e.published ? 'Unpublish' : 'Publish'}>
                          <button type="button" disabled={busy} onClick={() => togglePublish(e)} aria-label={e.published ? 'Unpublish' : 'Publish'}
                            className="text-xs px-2 py-1 rounded border border-zinc-200 hover:bg-zinc-50 inline-flex items-center gap-1">
                            {e.published ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}{e.published ? 'Unpublish' : 'Publish'}
                          </button>
                        </FastTooltip>
                        <FastTooltip label="Feature">
                          <button type="button" disabled={busy} onClick={() => toggleFeature(e)} aria-label="Feature"
                            className={cn('text-xs px-2 py-1 rounded border inline-flex items-center gap-1', e.featured ? 'border-amber-300 text-amber-700 bg-amber-50' : 'border-zinc-200 hover:bg-zinc-50')}>
                            <Star className="h-3 w-3" />
                          </button>
                        </FastTooltip>
                        {e.consent_state === 'none' && (
                          <FastTooltip label="Mark written permission on file">
                            <button type="button" disabled={busy} onClick={() => attest(e)} aria-label="Mark written permission on file"
                              className="text-xs px-2 py-1 rounded border border-zinc-200 hover:bg-zinc-50">Written permission</button>
                          </FastTooltip>
                        )}
                        <button type="button" disabled={busy || idx === 0} onClick={() => move(idx, -1)} className="text-xs p-1 rounded border border-zinc-200 hover:bg-zinc-50 disabled:opacity-30"><ArrowUp className="h-3 w-3" /></button>
                        <button type="button" disabled={busy || idx === entries.length - 1} onClick={() => move(idx, 1)} className="text-xs p-1 rounded border border-zinc-200 hover:bg-zinc-50 disabled:opacity-30"><ArrowDown className="h-3 w-3" /></button>
                      </>
                    )}
                    {canEdit && (
                      <button type="button" disabled={busy} onClick={() => remove(e)} className="text-xs p-1 rounded border border-red-200 text-red-600 hover:bg-red-50 ml-auto"><Trash2 className="h-3 w-3" /></button>
                    )}
                    {busy && <Loader2 className="h-3 w-3 animate-spin text-zinc-400" />}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {form && (
        <PortfolioForm
          form={form}
          setForm={setForm}
          onClose={() => setForm(null)}
          onSave={save}
          saving={saving}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Create / edit form (slide-over)                                     */
/* ------------------------------------------------------------------ */

function PortfolioForm({
  form, setForm, onClose, onSave, saving,
}: {
  form: FormState
  setForm: (f: FormState) => void
  onClose: () => void
  onSave: () => void
  saving: boolean
}) {
  const set = (patch: Partial<FormState>) => setForm({ ...form, ...patch })
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div className="w-full max-w-lg h-full bg-white shadow-xl overflow-y-auto" onClick={(ev) => ev.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b border-zinc-200 px-4 py-3 flex items-center justify-between">
          <h2 className="font-semibold">{form.id ? 'Edit entry' : 'New portfolio entry'}</h2>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-zinc-100"><X className="h-4 w-4" /></button>
        </div>
        <div className="p-4 space-y-4">
          <ImagePicker label="After (the result) — required" value={form.after_image_url} onChange={(url) => set({ after_image_url: url })} />
          <ImagePicker label="Before (old branding) — optional" value={form.before_image_url} onChange={(url) => set({ before_image_url: url })} />

          <Field label="Title (English)"><input className={inputCls} value={form.title_en} onChange={(e) => set({ title_en: e.target.value })} /></Field>
          <Field label="Title (Italian)"><input className={inputCls} value={form.title_it} onChange={(e) => set({ title_it: e.target.value })} /></Field>
          <Field label="Client name (public-safe — may anonymize)"><input className={inputCls} value={form.client_name} onChange={(e) => set({ client_name: e.target.value })} /></Field>
          <Field label="Description (English)"><textarea rows={2} className={inputCls} value={form.description_en} onChange={(e) => set({ description_en: e.target.value })} /></Field>
          <Field label="Description (Italian)"><textarea rows={2} className={inputCls} value={form.description_it} onChange={(e) => set({ description_it: e.target.value })} /></Field>
          <Field label="Category (free text)"><input className={inputCls} value={form.category} onChange={(e) => set({ category: e.target.value })} placeholder="e.g. Logo, Brand identity" /></Field>
          <Field label="Tags (comma-separated)"><input className={inputCls} value={form.tags} onChange={(e) => set({ tags: e.target.value })} placeholder="minimal, blue, tech" /></Field>
          <Field label="Link source project (optional — auto-links client consent)">
            <input className={inputCls} value={form.enrollment_id} onChange={(e) => set({ enrollment_id: e.target.value })} placeholder="enrollment id (optional)" />
          </Field>
        </div>
        <div className="sticky bottom-0 bg-white border-t border-zinc-200 px-4 py-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-zinc-200 hover:bg-zinc-50">Cancel</button>
          <button type="button" onClick={onSave} disabled={saving} className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 inline-flex items-center gap-1.5 disabled:opacity-60">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} {form.id ? 'Save' : 'Create draft'}
          </button>
        </div>
      </div>
    </div>
  )
}

const inputCls = 'w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="text-xs font-medium text-zinc-600 mb-1 block">{label}</span>{children}</label>
}

/** Image field: paste a URL, upload a file, or pick a released deliverable. */
function ImagePicker({ label, value, onChange }: { label: string; value: string; onChange: (url: string) => void }) {
  const [uploading, setUploading] = useState(false)
  const [picking, setPicking] = useState(false)
  const [options, setOptions] = useState<DeliverableOption[]>([])

  async function upload(file: File) {
    setUploading(true)
    try {
      const urlRes = await fetch(`${API}/upload-url`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_name: file.name }) })
      if (!urlRes.ok) throw new Error(await errorFrom(urlRes, 'Could not start the upload.'))
      const { signedUrl, publicUrl } = await urlRes.json()
      if (!signedUrl || !publicUrl) throw new Error('Could not start the upload.')
      const put = await fetch(signedUrl, { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file })
      if (!put.ok) throw new Error('The upload failed. Please try again.')
      onChange(publicUrl)
      toast.success('Image uploaded.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed.')
    } finally {
      setUploading(false)
    }
  }

  async function openPicker() {
    setPicking(true)
    try {
      const res = await fetch('/api/td-communication/landing/deliverable-options')
      if (!res.ok) throw new Error(await errorFrom(res, 'Could not load delivered work.'))
      const data = await res.json()
      setOptions(Array.isArray(data.options) ? data.options : [])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load delivered work.')
      setPicking(false)
    }
  }

  async function pick(id: string) {
    try {
      const res = await fetch(`${API}/copy-image`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deliverable_id: id }) })
      if (!res.ok) throw new Error(await errorFrom(res, 'Could not use that image.'))
      const { publicUrl } = await res.json()
      onChange(publicUrl)
      setPicking(false)
      toast.success('Image added.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not use that image.')
    }
  }

  return (
    <div>
      <span className="text-xs font-medium text-zinc-600 mb-1 block">{label}</span>
      <div className="flex items-start gap-3">
        <div className="h-20 w-20 shrink-0 rounded-lg border border-zinc-200 bg-zinc-50 overflow-hidden flex items-center justify-center">
          {value
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={value} alt="" className="h-full w-full object-contain" />
            : <ImageIcon className="h-6 w-6 text-zinc-300" />}
        </div>
        <div className="flex-1 space-y-1.5">
          <div className="flex gap-2">
            <label className="text-xs px-2 py-1 rounded border border-zinc-200 hover:bg-zinc-50 cursor-pointer inline-flex items-center gap-1">
              {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />} Upload
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f) }} />
            </label>
            <button type="button" onClick={openPicker} className="text-xs px-2 py-1 rounded border border-zinc-200 hover:bg-zinc-50">From delivered work</button>
            {value && <button type="button" onClick={() => onChange('')} className="text-xs px-2 py-1 rounded border border-zinc-200 hover:bg-zinc-50 text-zinc-500">Clear</button>}
          </div>
          <input className={inputCls} value={value} onChange={(e) => onChange(e.target.value)} placeholder="…or paste an image URL" />
        </div>
      </div>

      {picking && (
        <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4" onClick={() => setPicking(false)}>
          <div className="bg-white rounded-xl max-w-2xl w-full max-h-[80vh] overflow-y-auto p-4" onClick={(ev) => ev.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-sm">Released work</h3>
              <button type="button" onClick={() => setPicking(false)} className="p-1 rounded hover:bg-zinc-100"><X className="h-4 w-4" /></button>
            </div>
            {options.length === 0 ? (
              <p className="text-sm text-zinc-500 py-8 text-center">No released image deliverables yet.</p>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {options.map((o) => (
                  <button key={o.id} type="button" onClick={() => pick(o.id)} className="rounded-lg border border-zinc-200 overflow-hidden hover:border-blue-400">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {o.preview_url && <img src={o.preview_url} alt={o.file_name} className="aspect-square w-full object-contain bg-zinc-50" />}
                    <div className="text-[10px] p-1 truncate text-zinc-600">{o.file_name}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
