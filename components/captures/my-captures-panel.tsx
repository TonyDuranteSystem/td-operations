'use client'

/**
 * The actual "My Captures" browsing UI (search + thumbnail grid + lightbox) —
 * extracted from app/(dashboard)/captures/page.tsx so the SAME component can
 * render both there (a real, linkable page) and inside the popup overlay
 * (Antonio, 2026-09-04: "when I click on my pictures I don't want to leave
 * the page where I am but a new page should popup"). No page-level chrome
 * (heading, max-width) here on purpose — each consumer supplies its own.
 */
import { useEffect, useMemo, useState } from 'react'
import { Search, X, ImageOff, Send, Copy, Check } from 'lucide-react'
import { ShareExistingModal } from '@/components/captures/share-existing-modal'

interface CaptureRow {
  id: string
  title: string
  note: string | null
  image_name: string | null
  mime_type: string | null
  size_bytes: number | null
  destination: { type: string; id: string; label?: string } | null
  created_at: string
}

const DESTINATION_LABEL: Record<string, string> = {
  sticky_note: 'Sticky note',
  team_chat: 'Team chat',
  portal_chat: 'Client portal chat',
}

export function MyCapturesPanel() {
  const [captures, setCaptures] = useState<CaptureRow[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [sharingId, setSharingId] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle')

  // A failed load used to collapse into the SAME "You haven't captured
  // anything yet." empty state as genuinely having nothing (R099 violation,
  // bug-hunter finding 2026-09-04) — indistinguishable from the truth, with
  // no way to tell the difference or retry.
  useEffect(() => {
    let cancelled = false
    setLoadError(false)
    fetch('/api/captures')
      .then((r) => {
        if (!r.ok) throw new Error('load failed')
        return r.json()
      })
      .then((d) => {
        if (!cancelled) setCaptures(Array.isArray(d.captures) ? d.captures : [])
      })
      .catch(() => {
        if (!cancelled) {
          setCaptures(null)
          setLoadError(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [reloadToken])

  const filtered = useMemo(() => {
    if (!captures) return []
    const q = query.trim().toLowerCase()
    if (!q) return captures
    return captures.filter(
      (c) => c.title.toLowerCase().includes(q) || (c.note ?? '').toLowerCase().includes(q),
    )
  }, [captures, query])

  const openCapture = filtered.find((c) => c.id === openId) ?? null

  // Copies the actual picture (not a link to it) to the clipboard, so it can
  // be pasted straight into an email, a chat, anywhere — for a capture
  // that's NOT going through any of the three built-in destinations
  // (Antonio, 2026-09-05: "to copy it"). PNG is universally supported by the
  // Clipboard API's image-write; every capture this tool produces is one
  // (canvasToPngFile), so there's no format branch to get wrong here.
  const handleCopy = async (captureId: string) => {
    setCopyState('copying')
    try {
      const res = await fetch(`/api/captures/${captureId}/image`)
      if (!res.ok) throw new Error('load failed')
      const blob = await res.blob()
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
      setCopyState('copied')
      setTimeout(() => setCopyState('idle'), 1500)
    } catch {
      setCopyState('error')
      setTimeout(() => setCopyState('idle'), 2500)
    }
  }

  return (
    <div>
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-zinc-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your captures..."
          className="w-full rounded-md border border-zinc-200 py-2 pl-8 pr-3 text-sm"
        />
      </div>

      {loadError ? (
        <div className="mt-8 flex flex-col items-center gap-2 text-center text-sm">
          <p className="text-red-600">Could not load your captures.</p>
          <button
            onClick={() => setReloadToken((n) => n + 1)}
            className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-50"
          >
            Try again
          </button>
        </div>
      ) : captures === null ? (
        <p className="mt-8 text-center text-sm text-zinc-400">Loading...</p>
      ) : filtered.length === 0 ? (
        <p className="mt-8 text-center text-sm text-zinc-400">
          {captures.length === 0 ? "You haven't captured anything yet." : 'No matches.'}
        </p>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {filtered.map((c) => (
            <button
              key={c.id}
              onClick={() => setOpenId(c.id)}
              className="flex flex-col overflow-hidden rounded-md border border-zinc-200 text-left hover:border-zinc-300"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- server-proxied private image, not a Next-optimizable remote URL */}
              <img
                src={`/api/captures/${c.id}/image`}
                alt={c.title}
                className="aspect-video w-full bg-zinc-100 object-cover"
                loading="lazy"
              />
              <div className="flex flex-col gap-0.5 p-2">
                <span className="truncate text-xs font-medium text-zinc-700">{c.title}</span>
                <span className="text-[11px] text-zinc-400">
                  {c.destination ? DESTINATION_LABEL[c.destination.type] ?? c.destination.type : 'Not sent yet'}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      {openCapture && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4"
          onClick={() => setOpenId(null)}
        >
          <div className="flex max-h-full max-w-3xl flex-col gap-2" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between text-white">
              <div>
                <p className="text-sm font-medium">{openCapture.title}</p>
                {openCapture.note && <p className="text-xs text-zinc-300">{openCapture.note}</p>}
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setSharingId(openCapture.id)}
                  className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-white hover:bg-white/10"
                  aria-label="Share"
                >
                  <Send className="h-4 w-4" />
                  Share
                </button>
                <button
                  onClick={() => void handleCopy(openCapture.id)}
                  className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-white hover:bg-white/10"
                  aria-label="Copy picture"
                >
                  {copyState === 'copied' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {copyState === 'copying' ? 'Copying...' : copyState === 'copied' ? 'Copied' : copyState === 'error' ? 'Could not copy' : 'Copy'}
                </button>
                <button onClick={() => setOpenId(null)} className="rounded-full p-1.5 hover:bg-white/10" aria-label="Close">
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element -- server-proxied private image */}
            <img
              src={`/api/captures/${openCapture.id}/image`}
              alt={openCapture.title}
              className="max-h-[75vh] w-full rounded-md object-contain"
            />
          </div>
        </div>
      )}

      {sharingId && (
        <ShareExistingModal
          captureId={sharingId}
          imageUrl={`/api/captures/${sharingId}/image`}
          onClose={() => {
            setSharingId(null)
            // Refresh so the gallery's "Not sent yet" / destination label
            // reflects a just-completed share without a manual reload.
            setReloadToken((n) => n + 1)
          }}
        />
      )}

      {captures !== null && captures.length === 0 && (
        <div className="mt-16 flex flex-col items-center gap-2 text-zinc-300">
          <ImageOff className="h-10 w-10" />
        </div>
      )}
    </div>
  )
}
