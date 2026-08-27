'use client'

/**
 * TD Communication — Landing Page content editor (Phase 9). Reused in BOTH the
 * partner studio (/collab) and the CRM staff dashboard (/dashboard/td-communication).
 *
 * Draft → Publish workflow: edits autosave to the DRAFT; clients only ever see
 * the PUBLISHED snapshot; "Publish" promotes draft → published; "Discard" reverts
 * the draft. A live Preview (the real <TdCommLanding>) shows the draft with EN/IT
 * + mobile/desktop toggles. `canEdit=false` renders read-only (team staff).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  Loader2, Eye, Send, Undo2, Plus, Trash2, ArrowUp, ArrowDown,
  Upload, Images, Smartphone, Monitor, CircleDot, CheckCircle2, X,
} from 'lucide-react'
import { TdCommLanding } from './td-comm-landing'
import { DEFAULT_LANDING_CONTENT, landingContentEqual, MAX_PORTFOLIO_ITEMS } from '@/lib/td-communication/landing-content'
import type { LandingContent, PortfolioItem, TdCommPackage } from '@/lib/td-communication/types'
import { FastTooltip } from '@/components/ui/fast-tooltip'

const API = '/api/td-communication/landing'

interface DeliverableOption { id: string; file_name: string; preview_url: string | null }

const label = 'block text-xs font-medium text-gray-700 mb-1'
const input = 'w-full border border-zinc-300 rounded px-2 py-1.5 text-sm disabled:bg-gray-50 disabled:text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-200'

export function LandingEditor({ canEdit }: { canEdit: boolean }) {
  const [draft, setDraft] = useState<LandingContent | null>(null)
  const [published, setPublished] = useState<LandingContent | null>(null)
  const [packages, setPackages] = useState<TdCommPackage[]>([])
  const [publishedAt, setPublishedAt] = useState<string | null>(null)
  const [updatedBy, setUpdatedBy] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [savingState, setSavingState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [publishing, setPublishing] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [lang, setLang] = useState<'en' | 'it'>('en')
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop')
  const [showPreview, setShowPreview] = useState(true)

  // Deliverable picker
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerLoading, setPickerLoading] = useState(false)
  const [pickerOptions, setPickerOptions] = useState<DeliverableOption[]>([])

  const lastSavedRef = useRef<string>('') // JSON of the last draft we persisted
  const fileInputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(API)
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not load the landing page content.')
      }
      const data = await res.json()
      const d: LandingContent = data.draft ?? DEFAULT_LANDING_CONTENT
      setDraft(d)
      setPublished(data.published ?? DEFAULT_LANDING_CONTENT)
      setPackages(Array.isArray(data.packages) ? data.packages : [])
      setPublishedAt(data.published_at ?? null)
      setUpdatedBy(data.updated_by ?? null)
      lastSavedRef.current = JSON.stringify(d)
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not load the landing page content.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // Debounced autosave of the draft (only when it changed since last save).
  useEffect(() => {
    if (!draft || !canEdit) return
    const json = JSON.stringify(draft)
    if (json === lastSavedRef.current) return
    setSavingState('saving')
    const t = setTimeout(async () => {
      try {
        const res = await fetch(API, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: json,
        })
        if (!res.ok) {
          const dd = await res.json().catch(() => ({}))
          throw new Error(dd.error || 'Could not save the draft.')
        }
        lastSavedRef.current = json
        setSavingState('saved')
        setTimeout(() => setSavingState('idle'), 1500)
      } catch (err) {
        setSavingState('idle')
        toast.error(err instanceof Error && err.message ? err.message : 'Could not save the draft.')
      }
    }, 1000)
    return () => clearTimeout(t)
  }, [draft, canEdit])

  function setField<K extends keyof LandingContent>(k: K, v: LandingContent[K]) {
    setDraft((d) => (d ? { ...d, [k]: v } : d))
  }

  function setItem(i: number, patch: Partial<PortfolioItem>) {
    setDraft((d) => {
      if (!d) return d
      const items = d.portfolio_items.map((it, idx) => (idx === i ? { ...it, ...patch } : it))
      return { ...d, portfolio_items: items }
    })
  }
  function addItem(item: PortfolioItem) {
    setDraft((d) => {
      if (!d) return d
      if (d.portfolio_items.length >= MAX_PORTFOLIO_ITEMS) {
        toast.error(`You can add up to ${MAX_PORTFOLIO_ITEMS} portfolio items.`)
        return d
      }
      return { ...d, portfolio_items: [...d.portfolio_items, item] }
    })
  }
  function removeItem(i: number) {
    setDraft((d) => (d ? { ...d, portfolio_items: d.portfolio_items.filter((_, idx) => idx !== i) } : d))
  }
  function moveItem(i: number, dir: -1 | 1) {
    setDraft((d) => {
      if (!d) return d
      const j = i + dir
      if (j < 0 || j >= d.portfolio_items.length) return d
      const items = [...d.portfolio_items]
      ;[items[i], items[j]] = [items[j], items[i]]
      return { ...d, portfolio_items: items }
    })
  }

  async function onUploadFile(file: File) {
    if (!file.type.startsWith('image/')) { toast.error('Please choose an image file.'); return }
    if (file.size > 10 * 1024 * 1024) { toast.error('Image too large (max 10 MB).'); return }
    try {
      const urlRes = await fetch(`${API}/upload-url`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_name: file.name }),
      })
      if (!urlRes.ok) { const d = await urlRes.json().catch(() => ({})); throw new Error(d.error || 'Could not start the upload.') }
      const { signedUrl, publicUrl } = await urlRes.json()
      if (!signedUrl || !publicUrl) throw new Error('Could not start the upload.')
      const put = await fetch(signedUrl, { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file })
      if (!put.ok) throw new Error('Upload failed. Please try again.')
      addItem({ image_url: publicUrl, client_name: '', description_en: '', description_it: '' })
      toast.success('Image added.')
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Upload failed.')
    }
  }

  async function openPicker() {
    setPickerOpen(true)
    setPickerLoading(true)
    try {
      const res = await fetch(`${API}/deliverable-options`)
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Could not load deliverables.') }
      const data = await res.json()
      setPickerOptions(Array.isArray(data.options) ? data.options : [])
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not load deliverables.')
      setPickerOptions([])
    } finally {
      setPickerLoading(false)
    }
  }
  async function chooseDeliverable(opt: DeliverableOption) {
    try {
      const res = await fetch(`${API}/portfolio-from-deliverable`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deliverable_id: opt.id }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Could not add this deliverable.') }
      const { publicUrl } = await res.json()
      if (!publicUrl) throw new Error('Could not add this deliverable.')
      addItem({ image_url: publicUrl, client_name: '', description_en: '', description_it: '' })
      setPickerOpen(false)
      toast.success('Added to portfolio. Set a client name & description.')
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not add this deliverable.')
    }
  }

  async function flushDraft(): Promise<boolean> {
    if (!draft) return false
    const json = JSON.stringify(draft)
    if (json === lastSavedRef.current) return true
    const res = await fetch(API, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: json })
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Could not save the draft.') }
    lastSavedRef.current = json
    return true
  }

  async function publish() {
    if (!draft) return
    setPublishing(true)
    try {
      await flushDraft() // make sure the latest edits are in the draft before promoting
      const res = await fetch(API, { method: 'POST' })
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Could not publish.') }
      const data = await res.json()
      setPublished(data.published ?? draft)
      setPublishedAt(data.published_at ?? null)
      setUpdatedBy(data.updated_by ?? null)
      toast.success('Published — clients now see your changes.')
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not publish.')
    } finally {
      setPublishing(false)
    }
  }

  async function discard() {
    setDiscarding(true)
    try {
      const res = await fetch(API, { method: 'DELETE' })
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Could not discard changes.') }
      const data = await res.json()
      const d: LandingContent = data.draft ?? published ?? DEFAULT_LANDING_CONTENT
      setDraft(d)
      lastSavedRef.current = JSON.stringify(d)
      toast.success('Unpublished changes discarded.')
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not discard changes.')
    } finally {
      setDiscarding(false)
    }
  }

  if (loading || !draft || !published) {
    return <div className="flex-1 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-zinc-400" /></div>
  }

  const dirty = !landingContentEqual(draft, published)
  const isLive = !published.coming_soon
  const suffix = lang === 'en' ? '_en' : '_it'

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Top bar */}
      <div className="shrink-0 flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 pb-3 mb-3">
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full ${isLive ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
            <CircleDot className="h-3.5 w-3.5" /> {isLive ? 'Live landing page' : 'Coming Soon mode'}
          </span>
          {dirty ? (
            <span className="text-xs font-medium text-amber-600">● Unpublished changes</span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-zinc-400"><CheckCircle2 className="h-3.5 w-3.5" /> Published</span>
          )}
          {savingState === 'saving' && <span className="text-xs text-zinc-400">Saving…</span>}
          {savingState === 'saved' && <span className="text-xs text-zinc-400">Saved</span>}
        </div>
        {canEdit && (
          <div className="flex items-center gap-2">
            <button onClick={discard} disabled={!dirty || discarding} className="inline-flex items-center gap-1.5 text-sm font-medium rounded border border-zinc-300 text-zinc-700 px-3 py-1.5 hover:bg-zinc-50 disabled:opacity-40">
              {discarding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />} Discard
            </button>
            <button onClick={publish} disabled={publishing} className="inline-flex items-center gap-1.5 text-sm font-semibold rounded bg-blue-600 text-white px-4 py-1.5 hover:bg-blue-700 disabled:opacity-50">
              {publishing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Publish
            </button>
          </div>
        )}
      </div>

      {!canEdit && (
        <p className="shrink-0 mb-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          Read-only — only an admin can edit the landing page.
        </p>
      )}

      <div className="flex-1 min-h-0 grid lg:grid-cols-2 gap-5 overflow-hidden">
        {/* ---- Editor column ---- */}
        <div className="min-h-0 overflow-y-auto pr-1 space-y-5">
          {/* Live toggle */}
          <div className="border rounded-lg bg-white p-4">
            <label className="flex items-center justify-between gap-4">
              <span>
                <span className="block text-sm font-medium text-zinc-900">Show the full landing page</span>
                <span className="block text-xs text-zinc-500">Off = clients see the &ldquo;Coming Soon&rdquo; teaser. On = the full landing page. Takes effect on Publish.</span>
              </span>
              <input type="checkbox" className="h-5 w-5" disabled={!canEdit} checked={!draft.coming_soon} onChange={(e) => setField('coming_soon', !e.target.checked)} />
            </label>
          </div>

          {/* Language tab */}
          <div className="flex items-center gap-1 text-sm">
            <span className="text-xs text-zinc-500 mr-1">Language:</span>
            {(['en', 'it'] as const).map((l) => (
              <button key={l} onClick={() => setLang(l)} className={`px-3 py-1 rounded font-medium ${lang === l ? 'bg-blue-600 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'}`}>
                {l === 'en' ? 'English' : 'Italiano'}
              </button>
            ))}
          </div>

          {/* Hero */}
          <div className="border rounded-lg bg-white p-4 space-y-3">
            <h4 className="text-sm font-semibold text-zinc-900">Hero</h4>
            <label className="block"><span className={label}>Headline ({lang.toUpperCase()})</span>
              <input className={input} disabled={!canEdit} value={draft[`hero_headline${suffix}` as keyof LandingContent] as string} onChange={(e) => setField(`hero_headline${suffix}` as keyof LandingContent, e.target.value as never)} /></label>
            <label className="block"><span className={label}>Subheadline ({lang.toUpperCase()})</span>
              <input className={input} disabled={!canEdit} value={draft[`hero_subheadline${suffix}` as keyof LandingContent] as string} onChange={(e) => setField(`hero_subheadline${suffix}` as keyof LandingContent, e.target.value as never)} /></label>
          </div>

          {/* Problem */}
          <div className="border rounded-lg bg-white p-4 space-y-3">
            <h4 className="text-sm font-semibold text-zinc-900">Problem statement</h4>
            <label className="block"><span className={label}>Body ({lang.toUpperCase()})</span>
              <textarea className={input} rows={4} disabled={!canEdit} value={draft[`problem_body${suffix}` as keyof LandingContent] as string} onChange={(e) => setField(`problem_body${suffix}` as keyof LandingContent, e.target.value as never)} /></label>
          </div>

          {/* CTA */}
          <div className="border rounded-lg bg-white p-4 space-y-3">
            <h4 className="text-sm font-semibold text-zinc-900">Call to action</h4>
            <label className="block"><span className={label}>Button text ({lang.toUpperCase()})</span>
              <input className={input} disabled={!canEdit} value={draft[`cta_text${suffix}` as keyof LandingContent] as string} onChange={(e) => setField(`cta_text${suffix}` as keyof LandingContent, e.target.value as never)} /></label>
          </div>

          {/* Portfolio */}
          <div className="border rounded-lg bg-white p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold text-zinc-900">Portfolio <span className="text-xs font-normal text-zinc-400">({draft.portfolio_items.length}/{MAX_PORTFOLIO_ITEMS})</span></h4>
              {canEdit && (
                <div className="flex items-center gap-2">
                  <button onClick={() => fileInputRef.current?.click()} className="inline-flex items-center gap-1 text-[11px] font-medium rounded border border-blue-200 text-blue-700 px-2 py-1 hover:bg-blue-50"><Upload className="h-3.5 w-3.5" /> Upload</button>
                  <button onClick={openPicker} className="inline-flex items-center gap-1 text-[11px] font-medium rounded border border-blue-200 text-blue-700 px-2 py-1 hover:bg-blue-50"><Images className="h-3.5 w-3.5" /> From deliverables</button>
                  <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void onUploadFile(f); e.target.value = '' }} />
                </div>
              )}
            </div>
            {draft.portfolio_items.length === 0 && <p className="text-xs text-zinc-400">No items yet. Upload an image or add one from your delivered work.</p>}
            <div className="space-y-3">
              {draft.portfolio_items.map((item, i) => (
                <div key={i} className="flex gap-3 rounded-lg border border-zinc-200 p-2.5">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={item.image_url} alt="" className="h-16 w-16 rounded object-cover bg-zinc-100 shrink-0" />
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <input className={input} disabled={!canEdit} placeholder="Image URL" value={item.image_url} onChange={(e) => setItem(i, { image_url: e.target.value })} />
                    <input className={input} disabled={!canEdit} placeholder="Client name" value={item.client_name} onChange={(e) => setItem(i, { client_name: e.target.value })} />
                    <input className={input} disabled={!canEdit} placeholder={`Description (${lang.toUpperCase()})`} value={lang === 'en' ? item.description_en : item.description_it} onChange={(e) => setItem(i, lang === 'en' ? { description_en: e.target.value } : { description_it: e.target.value })} />
                  </div>
                  {canEdit && (
                    <div className="flex flex-col gap-1 shrink-0">
                      <FastTooltip label="Move up"><button onClick={() => moveItem(i, -1)} disabled={i === 0} className="p-1 rounded hover:bg-zinc-100 disabled:opacity-30" aria-label="Move up"><ArrowUp className="h-3.5 w-3.5" /></button></FastTooltip>
                      <FastTooltip label="Move down"><button onClick={() => moveItem(i, 1)} disabled={i === draft.portfolio_items.length - 1} className="p-1 rounded hover:bg-zinc-100 disabled:opacity-30" aria-label="Move down"><ArrowDown className="h-3.5 w-3.5" /></button></FastTooltip>
                      <FastTooltip label="Remove"><button onClick={() => removeItem(i)} className="p-1 rounded hover:bg-red-50 text-red-500" aria-label="Remove"><Trash2 className="h-3.5 w-3.5" /></button></FastTooltip>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {updatedBy && (
            <p className="text-[11px] text-zinc-400">
              {publishedAt ? `Last published by ${updatedBy}` : `Last edited by ${updatedBy}`}
            </p>
          )}
        </div>

        {/* ---- Preview column ---- */}
        <div className="min-h-0 flex flex-col border border-zinc-200 rounded-lg bg-zinc-50 overflow-hidden">
          <div className="shrink-0 flex items-center justify-between gap-2 px-3 py-2 border-b border-zinc-200 bg-white">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-500"><Eye className="h-3.5 w-3.5" /> Preview (draft)</span>
            <div className="flex items-center gap-1">
              {(['en', 'it'] as const).map((l) => (
                <button key={l} onClick={() => setLang(l)} className={`px-2 py-0.5 text-[11px] rounded ${lang === l ? 'bg-blue-100 text-blue-700' : 'text-zinc-500 hover:bg-zinc-100'}`}>{l.toUpperCase()}</button>
              ))}
              <span className="w-px h-4 bg-zinc-200 mx-0.5" />
              <FastTooltip label="Desktop"><button onClick={() => setDevice('desktop')} className={`p-1 rounded ${device === 'desktop' ? 'bg-blue-100 text-blue-700' : 'text-zinc-500 hover:bg-zinc-100'}`} aria-label="Desktop"><Monitor className="h-3.5 w-3.5" /></button></FastTooltip>
              <FastTooltip label="Mobile"><button onClick={() => setDevice('mobile')} className={`p-1 rounded ${device === 'mobile' ? 'bg-blue-100 text-blue-700' : 'text-zinc-500 hover:bg-zinc-100'}`} aria-label="Mobile"><Smartphone className="h-3.5 w-3.5" /></button></FastTooltip>
              <FastTooltip label="Toggle preview"><button onClick={() => setShowPreview((s) => !s)} className="lg:hidden p-1 rounded text-zinc-500 hover:bg-zinc-100" aria-label="Toggle preview">{showPreview ? <X className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}</button></FastTooltip>
            </div>
          </div>
          {showPreview && (
            <div className="flex-1 min-h-0 overflow-y-auto p-3">
              <div className={`mx-auto bg-white transition-all ${device === 'mobile' ? 'max-w-[390px]' : 'max-w-full'} rounded-lg shadow-sm`}>
                <TdCommLanding content={draft} packages={packages} locale={lang} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Deliverable picker modal */}
      {pickerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setPickerOpen(false)}>
          <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200">
              <h3 className="text-sm font-semibold text-zinc-900">Add from delivered work</h3>
              <button onClick={() => setPickerOpen(false)} className="p-1 rounded hover:bg-zinc-100 text-zinc-500"><X className="h-4 w-4" /></button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-4">
              {pickerLoading ? (
                <div className="flex items-center justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-zinc-400" /></div>
              ) : pickerOptions.length === 0 ? (
                <p className="text-sm text-zinc-500 text-center py-10">No released image deliverables yet.</p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {pickerOptions.map((opt) => (
                    <button key={opt.id} onClick={() => void chooseDeliverable(opt)} className="group rounded-lg border border-zinc-200 overflow-hidden text-left hover:border-blue-400 hover:shadow">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {opt.preview_url && <img src={opt.preview_url} alt={opt.file_name} className="aspect-square w-full object-cover" />}
                      <span className="block px-2 py-1.5 text-[11px] text-zinc-600 truncate">{opt.file_name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="px-4 py-2.5 border-t border-zinc-200">
              <p className="inline-flex items-center gap-1.5 text-[11px] text-zinc-400"><Plus className="h-3 w-3" /> Click an image to copy it into the portfolio, then add a public-safe client name & description.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
