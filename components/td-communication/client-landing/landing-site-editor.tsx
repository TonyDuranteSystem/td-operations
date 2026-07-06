'use client'

/**
 * TD Communication — Client Landing Page editor (Phase 16).
 *
 * A lazy section of the shared project brief panel (so it renders on BOTH /collab
 * and the CRM). Gated by the package's includes_landing flag (+ an admin override).
 * Autosaves the draft with optimistic-concurrency (409 → reload); publish freezes
 * the draft to the public /site/<slug> page. Live preview via ClientLandingRenderer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  newSection,
  SECTION_TYPE_LABELS,
  SECTION_TYPES_LIST,
  FONT_KEYS,
  deriveThemeFromProfile,
} from '@/lib/td-communication/client-landing'
import { ClientLandingRenderer } from './client-landing-renderer'
import { SectionReadme } from '../section-readmes'
import type {
  ClientLandingContent,
  ClientLandingSite,
  ClandSection,
  ClandSectionType,
  ClandTheme,
  ClandFontKey,
} from '@/lib/td-communication/types'

type Palette = { hex: string; name?: string }[]

interface EditorState {
  site: ClientLandingSite
  hasUnpublishedChanges: boolean
  publicUrl: string
}

const FONT_LABELS: Record<ClandFontKey, string> = {
  modern_sans: 'Modern Sans',
  elegant_serif: 'Elegant Serif',
  geometric: 'Geometric',
}

export function LandingSiteEditor({
  enrollmentId,
  brandPalette,
}: {
  enrollmentId: string
  brandPalette?: Palette
}) {
  const base = `/api/td-communication/projects/${enrollmentId}/landing-site`

  const [loading, setLoading] = useState(true)
  const [includesLanding, setIncludesLanding] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const [state, setState] = useState<EditorState | null>(null)
  const [content, setContent] = useState<ClientLandingContent | null>(null)
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop')

  // expectedUpdatedAt for optimistic concurrency — the last server-confirmed token.
  const tokenRef = useRef<string>('')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtyRef = useRef(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(base, { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not load the landing page.')
      setIncludesLanding(!!data.includesLanding)
      setIsAdmin(!!data.isAdmin)
      if (data.state) {
        setState(data.state)
        setContent(data.state.site.content)
        tokenRef.current = data.state.site.updated_at
      } else {
        setState(null)
        setContent(null)
      }
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not load the landing page.')
    } finally {
      setLoading(false)
    }
  }, [base])

  useEffect(() => {
    void load()
  }, [load])

  const applyState = (s: EditorState) => {
    setState(s)
    setContent(s.site.content)
    tokenRef.current = s.site.updated_at
    setConflict(false)
    dirtyRef.current = false
  }

  const doCreate = async () => {
    setBusy(true)
    try {
      const theme = brandPalette && brandPalette.length ? deriveThemeFromProfile({ color_palette: brandPalette } as never) : undefined
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', theme }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not create the landing page.')
      applyState(data.state)
      toast.success('Landing page created — start editing.')
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not create the landing page.')
    } finally {
      setBusy(false)
    }
  }

  // --- autosave (debounced) ---
  const flushSave = useCallback(async () => {
    if (!state || !content || !dirtyRef.current || conflict) return
    dirtyRef.current = false
    try {
      const res = await fetch(base, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save', siteId: state.site.id, expectedUpdatedAt: tokenRef.current, content }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 409) {
        setConflict(true)
        return
      }
      if (!res.ok) throw new Error(data.error || 'Could not save.')
      // Keep the local edits; just advance the concurrency token + published-diff flag.
      tokenRef.current = data.state.site.updated_at
      setState((prev) => (prev ? { ...prev, site: { ...prev.site, updated_at: data.state.site.updated_at, published_content: data.state.site.published_content, published: data.state.site.published }, hasUnpublishedChanges: data.state.hasUnpublishedChanges } : prev))
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not save.')
    }
  }, [base, state, content, conflict])

  const scheduleSave = useCallback(() => {
    dirtyRef.current = true
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void flushSave(), 1000)
  }, [flushSave])

  // mutate content + schedule a save
  const patchContent = (fn: (c: ClientLandingContent) => ClientLandingContent) => {
    setContent((prev) => (prev ? fn(prev) : prev))
    scheduleSave()
  }

  const setTheme = (patch: Partial<ClandTheme>) => patchContent((c) => ({ ...c, theme: { ...c.theme, ...patch } }))
  const setSectionAt = (idx: number, patch: Partial<ClandSection>) =>
    patchContent((c) => ({ ...c, sections: c.sections.map((s, i) => (i === idx ? ({ ...s, ...patch } as ClandSection) : s)) }))
  const addSection = (type: ClandSectionType) => patchContent((c) => ({ ...c, sections: [...c.sections, newSection(type)] }))
  const removeSection = (idx: number) => patchContent((c) => ({ ...c, sections: c.sections.filter((_, i) => i !== idx) }))
  const moveSection = (idx: number, dir: -1 | 1) =>
    patchContent((c) => {
      const j = idx + dir
      if (j < 0 || j >= c.sections.length) return c
      const next = [...c.sections]
      ;[next[idx], next[j]] = [next[j], next[idx]]
      return { ...c, sections: next }
    })

  const doAction = async (action: 'publish' | 'unpublish') => {
    if (!state) return
    setBusy(true)
    try {
      // flush any pending edit first so publish captures the latest draft
      if (dirtyRef.current) await flushSave()
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, siteId: state.site.id }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Action failed.')
      applyState(data.state)
      toast.success(action === 'publish' ? 'Published — the page is live.' : 'Unpublished.')
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Action failed.')
    } finally {
      setBusy(false)
    }
  }

  const doRename = async (slug: string) => {
    if (!state) return
    setBusy(true)
    try {
      const res = await fetch(base, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rename', siteId: state.site.id, slug, expectedUpdatedAt: tokenRef.current }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 409) { setConflict(true); return }
      if (!res.ok) throw new Error(data.error || 'Could not rename.')
      applyState(data.state)
      toast.success('Address updated.')
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not rename.')
    } finally {
      setBusy(false)
    }
  }

  const doDelete = async () => {
    if (!state) return
    if (!window.confirm('Delete this landing page? The public URL will stop working.')) return
    setBusy(true)
    try {
      const res = await fetch(base, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId: state.site.id }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not delete.')
      setState(null)
      setContent(null)
      toast.success('Landing page deleted.')
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not delete.')
    } finally {
      setBusy(false)
    }
  }

  const uploadLogo = async (file: File) => {
    setBusy(true)
    try {
      const urlRes = await fetch(`${base}/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_name: file.name }),
      })
      const urlData = await urlRes.json().catch(() => ({}))
      if (!urlRes.ok) throw new Error(urlData.error || 'Could not start the upload.')
      const up = await fetch(urlData.signedUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file })
      if (!up.ok) throw new Error('Upload failed. Please try again.')
      setTheme({ logo_url: urlData.publicUrl })
      toast.success('Logo uploaded.')
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Upload failed.')
    } finally {
      setBusy(false)
    }
  }

  const preview = useMemo(
    () => (content ? <ClientLandingRenderer title={state?.site.title} theme={content.theme} sections={content.sections} /> : null),
    [content, state?.site.title],
  )

  const readme = (
    <SectionReadme title="How the Landing Page builder works — read me">
      <section className="space-y-1">
        <h3 className="font-semibold text-zinc-900">What it is</h3>
        <p>
          A simple one-page <strong>public website</strong> for this client, built from their brand. You add
          sections (hero, about, services, gallery, contact, custom text), theme it with their colours, font and
          logo, then <strong>Publish</strong> it to a shareable web address (<code>…/site/&lt;name&gt;</code>). Once
          the project is delivered, the client sees a &ldquo;your landing page is live&rdquo; card in their portal.
          This is the client&rsquo;s <strong>own</strong> site — different from the TD Communication marketing page.
        </p>
      </section>
      <section className="space-y-1">
        <h3 className="font-semibold text-zinc-900">How to use it</h3>
        <ol className="list-decimal pl-5 space-y-1">
          <li><strong>Create landing page</strong> to start from a default layout (hero → about → services → contact).</li>
          <li>Set the <strong>theme</strong> — colours (or &ldquo;Use brand colours&rdquo;), a font, and upload the <strong>logo</strong>.</li>
          <li>Edit each <strong>section</strong>: fill the text, add/remove items, use ↑/↓ to reorder, and untick <em>shown</em> to hide one. Add more sections from the buttons at the bottom.</li>
          <li>Watch the <strong>live preview</strong> (Desktop / Mobile). Everything <strong>autosaves</strong> as a draft.</li>
          <li><strong>Publish</strong> when it&rsquo;s ready, then <strong>Copy</strong> the public URL to share it. Use <strong>Rename</strong> to change the web address.</li>
        </ol>
      </section>
      <section className="space-y-1">
        <h3 className="font-semibold text-amber-700">Good to know</h3>
        <ul className="list-disc pl-5 space-y-1">
          <li><strong>Two things must be true for the page to be live:</strong> you&rsquo;ve <strong>Published</strong> it <em>and</em> an admin has turned on <strong>&ldquo;Client landing pages&rdquo;</strong> in Settings. Until then the address shows &ldquo;coming soon&rdquo;.</li>
          <li>The public page only shows text and <strong>images hosted by us</strong> (the logo you upload, or released work) — nothing private from the brief.</li>
          <li><strong>Publishing freezes a snapshot.</strong> Later edits don&rsquo;t change the live page until you Publish again.</li>
          <li><strong>Delete</strong> stops the public URL working. The address survives even if the project is later removed.</li>
          <li>Only packages that <strong>include a landing page</strong> show this section (admins can enable it anyway).</li>
        </ul>
      </section>
    </SectionReadme>
  )

  if (loading) return <div className="text-sm text-gray-500 p-2">Loading landing page…</div>

  // --- gate: no site yet ---
  if (!state || !content) {
    if (!includesLanding && !isAdmin) {
      return (
        <div className="space-y-3">
          {readme}
          <div className="text-sm text-gray-500 p-3 border rounded bg-gray-50">This package doesn&rsquo;t include a landing page.</div>
        </div>
      )
    }
    return (
      <div className="space-y-3">
      {readme}
      <div className="p-3 border rounded bg-white space-y-2">
        <p className="text-sm text-gray-700">Build a one-page landing site for this client from their brand.</p>
        {!includesLanding && isAdmin ? (
          <p className="text-xs text-amber-700">This package doesn&rsquo;t normally include a landing page — enabling as admin.</p>
        ) : null}
        <button onClick={doCreate} disabled={busy} className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm rounded font-medium px-3 py-1.5">
          {busy ? 'Creating…' : 'Create landing page'}
        </button>
      </div>
      </div>
    )
  }

  const published = state.site.published

  return (
    <div className="space-y-3">
      {readme}
      {conflict ? (
        <div className="p-2 rounded bg-amber-50 border border-amber-300 text-sm text-amber-800 flex items-center justify-between gap-2">
          <span>This page was changed elsewhere. Reload to get the latest version (your unsaved edits will be lost).</span>
          <button onClick={load} className="border border-amber-400 rounded px-2 py-1 text-xs font-medium">Reload</button>
        </div>
      ) : null}

      {/* Status bar */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className={`px-2 py-0.5 rounded text-xs font-medium ${published ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700'}`}>
          {published ? 'Published' : 'Draft'}
        </span>
        {state.hasUnpublishedChanges && published ? <span className="text-xs text-amber-700">unpublished changes</span> : null}
        <span className="ml-auto flex items-center gap-2">
          {published ? (
            <button onClick={() => doAction('unpublish')} disabled={busy} className="border text-gray-700 hover:bg-gray-50 text-xs rounded px-2 py-1">Unpublish</button>
          ) : null}
          <button onClick={() => doAction('publish')} disabled={busy} className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs rounded font-medium px-3 py-1">
            {published ? 'Republish' : 'Publish'}
          </button>
          <button onClick={doDelete} disabled={busy} className="text-red-600 hover:bg-red-50 text-xs rounded px-2 py-1">Delete</button>
        </span>
      </div>

      {/* Public URL + slug */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-gray-500">Public URL:</span>
        <a href={state.publicUrl} target="_blank" rel="noreferrer" className="text-blue-600 underline break-all">{state.publicUrl}</a>
        <button
          onClick={() => { navigator.clipboard?.writeText(state.publicUrl); toast.success('Copied.') }}
          className="border rounded px-2 py-0.5 text-gray-600 hover:bg-gray-50"
        >Copy</button>
        <button
          onClick={() => { const s = window.prompt('New address (letters, numbers, hyphens):', state.site.slug); if (s && s.trim()) void doRename(s.trim()) }}
          className="border rounded px-2 py-0.5 text-gray-600 hover:bg-gray-50"
        >Rename</button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Editor column */}
        <div className="space-y-4">
          {/* Theme */}
          <fieldset className="border rounded p-3 space-y-2">
            <legend className="text-xs font-semibold text-gray-600 px-1">Theme</legend>
            <div className="flex flex-wrap gap-3">
              {(['primary', 'secondary', 'accent', 'text'] as const).map((k) => (
                <label key={k} className="flex flex-col items-center text-[11px] text-gray-500">
                  <input type="color" value={content.theme[k]} onChange={(e) => setTheme({ [k]: e.target.value } as Partial<ClandTheme>)} className="h-8 w-10 rounded border" />
                  {k}
                </label>
              ))}
              {brandPalette && brandPalette.length ? (
                <button onClick={() => setTheme(deriveThemeFromProfile({ color_palette: brandPalette } as never))} className="self-end border rounded px-2 py-1 text-xs text-gray-600 hover:bg-gray-50">Use brand colors</button>
              ) : null}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <label className="text-xs text-gray-600">Font
                <select value={content.theme.font_key} onChange={(e) => setTheme({ font_key: e.target.value as ClandFontKey })} className="ml-1 border rounded text-sm px-1 py-0.5">
                  {FONT_KEYS.map((f) => <option key={f} value={f}>{FONT_LABELS[f]}</option>)}
                </select>
              </label>
              <label className="text-xs text-gray-600 inline-flex items-center gap-1">
                Logo:
                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadLogo(f) }} className="text-xs" />
              </label>
              {content.theme.logo_url ? <button onClick={() => setTheme({ logo_url: null })} className="text-xs text-red-600">remove logo</button> : null}
            </div>
          </fieldset>

          {/* Sections */}
          <div className="space-y-2">
            {content.sections.map((sec, idx) => (
              <SectionEditor
                key={sec.id}
                section={sec}
                onChange={(patch) => setSectionAt(idx, patch)}
                onRemove={() => removeSection(idx)}
                onUp={() => moveSection(idx, -1)}
                onDown={() => moveSection(idx, 1)}
                isFirst={idx === 0}
                isLast={idx === content.sections.length - 1}
              />
            ))}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-gray-500">Add section:</span>
            {SECTION_TYPES_LIST.map((t) => (
              <button key={t} onClick={() => addSection(t)} className="border rounded px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50">+ {SECTION_TYPE_LABELS[t]}</button>
            ))}
          </div>
        </div>

        {/* Preview column */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span>Preview</span>
            <button onClick={() => setDevice('desktop')} className={`border rounded px-2 py-0.5 ${device === 'desktop' ? 'bg-gray-200' : ''}`}>Desktop</button>
            <button onClick={() => setDevice('mobile')} className={`border rounded px-2 py-0.5 ${device === 'mobile' ? 'bg-gray-200' : ''}`}>Mobile</button>
          </div>
          <div className="border rounded overflow-hidden bg-white" style={{ maxWidth: device === 'mobile' ? 380 : '100%', margin: device === 'mobile' ? '0 auto' : undefined }}>
            <div style={{ height: 520, overflowY: 'auto' }}>{preview}</div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------ section editor --------------------------- */

const inp = 'w-full border rounded text-sm px-2 py-1'

function SectionEditor({
  section,
  onChange,
  onRemove,
  onUp,
  onDown,
  isFirst,
  isLast,
}: {
  section: ClandSection
  onChange: (patch: Partial<ClandSection>) => void
  onRemove: () => void
  onUp: () => void
  onDown: () => void
  isFirst: boolean
  isLast: boolean
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = section as any
  const setField = (patch: Record<string, unknown>) => onChange(patch as Partial<ClandSection>)

  return (
    <div className={`border rounded p-3 space-y-2 ${section.enabled ? '' : 'opacity-60 bg-gray-50'}`}>
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-gray-600">{SECTION_TYPE_LABELS[section.type]}</span>
        <label className="text-[11px] text-gray-500 inline-flex items-center gap-1 ml-1">
          <input type="checkbox" checked={section.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} /> shown
        </label>
        <span className="ml-auto flex items-center gap-1">
          <button onClick={onUp} disabled={isFirst} className="text-xs px-1 disabled:opacity-30">↑</button>
          <button onClick={onDown} disabled={isLast} className="text-xs px-1 disabled:opacity-30">↓</button>
          <button onClick={onRemove} className="text-xs text-red-600 px-1">remove</button>
        </span>
      </div>

      {section.type === 'hero' ? (
        <div className="space-y-1">
          <input className={inp} placeholder="Headline" value={s.headline} onChange={(e) => setField({ headline: e.target.value })} />
          <textarea className={inp} rows={2} placeholder="Subheadline" value={s.subheadline} onChange={(e) => setField({ subheadline: e.target.value })} />
          <div className="flex gap-1">
            <input className={inp} placeholder="Button label" value={s.cta_label} onChange={(e) => setField({ cta_label: e.target.value })} />
            <input className={inp} placeholder="Button link (https://…)" value={s.cta_href} onChange={(e) => setField({ cta_href: e.target.value })} />
          </div>
        </div>
      ) : null}

      {section.type === 'about' || section.type === 'custom_text' ? (
        <div className="space-y-1">
          <input className={inp} placeholder="Heading" value={s.heading} onChange={(e) => setField({ heading: e.target.value })} />
          <textarea className={inp} rows={4} placeholder="Body text" value={s.body} onChange={(e) => setField({ body: e.target.value })} />
        </div>
      ) : null}

      {section.type === 'services' ? (
        <div className="space-y-1">
          <input className={inp} placeholder="Heading" value={s.heading} onChange={(e) => setField({ heading: e.target.value })} />
          {(s.items as { title: string; description: string }[]).map((it, i) => (
            <div key={i} className="flex gap-1">
              <input className={inp} placeholder="Title" value={it.title} onChange={(e) => setField({ items: s.items.map((x: unknown, j: number) => (j === i ? { ...it, title: e.target.value } : x)) })} />
              <input className={inp} placeholder="Description" value={it.description} onChange={(e) => setField({ items: s.items.map((x: unknown, j: number) => (j === i ? { ...it, description: e.target.value } : x)) })} />
              <button className="text-xs text-red-600 px-1" onClick={() => setField({ items: s.items.filter((_: unknown, j: number) => j !== i) })}>×</button>
            </div>
          ))}
          <button className="text-xs border rounded px-2 py-0.5 text-gray-600" onClick={() => setField({ items: [...s.items, { title: '', description: '' }] })}>+ item</button>
        </div>
      ) : null}

      {section.type === 'contact' ? (
        <div className="space-y-1">
          <input className={inp} placeholder="Heading" value={s.heading} onChange={(e) => setField({ heading: e.target.value })} />
          <div className="flex gap-1">
            <input className={inp} placeholder="Email" value={s.email} onChange={(e) => setField({ email: e.target.value })} />
            <input className={inp} placeholder="Phone" value={s.phone} onChange={(e) => setField({ phone: e.target.value })} />
          </div>
          {(s.links as { label: string; href: string }[]).map((l, i) => (
            <div key={i} className="flex gap-1">
              <input className={inp} placeholder="Label" value={l.label} onChange={(e) => setField({ links: s.links.map((x: unknown, j: number) => (j === i ? { ...l, label: e.target.value } : x)) })} />
              <input className={inp} placeholder="https://…" value={l.href} onChange={(e) => setField({ links: s.links.map((x: unknown, j: number) => (j === i ? { ...l, href: e.target.value } : x)) })} />
              <button className="text-xs text-red-600 px-1" onClick={() => setField({ links: s.links.filter((_: unknown, j: number) => j !== i) })}>×</button>
            </div>
          ))}
          <button className="text-xs border rounded px-2 py-0.5 text-gray-600" onClick={() => setField({ links: [...s.links, { label: '', href: '' }] })}>+ link</button>
        </div>
      ) : null}

      {section.type === 'gallery' ? (
        <div className="space-y-1 text-xs text-gray-500">
          <input className={inp} placeholder="Heading" value={s.heading} onChange={(e) => setField({ heading: e.target.value })} />
          <p>Gallery images come from released deliverables or uploads — add via the logo uploader pattern (v1: heading + existing images only).</p>
        </div>
      ) : null}
    </div>
  )
}

export default LandingSiteEditor
