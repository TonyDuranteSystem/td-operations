'use client'

/**
 * The actual "My Captures" browsing UI (search + thumbnail grid + lightbox) —
 * extracted from app/(dashboard)/captures/page.tsx so the SAME component can
 * render both there (a real, linkable page) and inside the popup overlay
 * (Antonio, 2026-09-04: "when I click on my pictures I don't want to leave
 * the page where I am but a new page should popup"). No page-level chrome
 * (heading, max-width) here on purpose — each consumer supplies its own.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X, ImageOff, Send, Copy, Check, Download, Mail, AlertCircle } from 'lucide-react'
import { ShareExistingModal } from '@/components/captures/share-existing-modal'
import { ComposeDialog } from '@/components/inbox/compose-dialog'
import { FastTooltip } from '@/components/ui/fast-tooltip'

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
  const [downloadState, setDownloadState] = useState<'idle' | 'downloading' | 'error'>('idle')
  const [emailState, setEmailState] = useState<'idle' | 'preparing' | 'error'>('idle')
  const [emailPayload, setEmailPayload] = useState<{ file: File; subject: string } | null>(null)

  // Synchronous truth for "which capture is actually open right now" — the
  // lightbox is a full-screen overlay with no next/prev control, so openId
  // can only ever go null<->id, never id1->id2 directly, but it CAN close
  // (id->null) while a Download/Email fetch for that same id is still in
  // flight. A closure-captured captureId can't see that; a ref read at the
  // moment the fetch resolves can (same pattern as filesRef in
  // use-email-attachments.ts).
  const openIdRef = useRef<string | null>(null)
  useEffect(() => {
    openIdRef.current = openId
  }, [openId])

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

  // Every capture this tool produces is a PNG (canvasToPngFile) — but a
  // capture that started life as a dropped/pasted non-PNG image keeps that
  // ORIGINAL file's name verbatim on its own row (markup-editor.tsx re-encodes
  // the bytes to PNG but not the name), so image_name can legitimately read
  // "photo.jpg" on bytes that are actually PNG (bug-hunter finding,
  // 2026-09-06). Building the download/attachment name from the capture's
  // own (always non-empty, DB-constrained) title instead of the nullable,
  // possibly-mismatched image_name/mime_type sidesteps that entirely — this
  // name is honest about what the bytes actually are, always.
  function captureFileName(title: string): string {
    const safe = title.replace(/[/\\?%*:|"<>]/g, '-').trim() || 'screenshot'
    return `${safe}.png`
  }

  // Copies the actual picture (not a link to it) to the clipboard, so it can
  // be pasted straight into an email, a chat, anywhere — for a capture
  // that's NOT going through any of the three built-in destinations
  // (Antonio, 2026-09-05: "to copy it"). PNG is universally supported by the
  // Clipboard API's image-write; every capture this tool produces is one
  // (canvasToPngFile), so there's no format branch to get wrong here.
  const handleCopy = async (captureId: string) => {
    if (copyState === 'copying') return
    setCopyState('copying')
    try {
      const res = await fetch(`/api/captures/${captureId}/image`)
      if (!res.ok) throw new Error('load failed')
      const blob = await res.blob()
      // Only the SIDE EFFECT is skipped once the lightbox has moved on
      // (copying something the user is no longer looking at is pointless,
      // possibly surprising) — the state machine still resolves normally
      // either way, or a genuine later attempt on a reopened capture would
      // find copyState stuck at 'copying' forever and refuse to start
      // (bug in an earlier version of this guard, caught before shipping).
      if (openIdRef.current === captureId) {
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
      }
      setCopyState('copied')
      setTimeout(() => setCopyState('idle'), 1500)
    } catch {
      setCopyState('error')
      setTimeout(() => setCopyState('idle'), 2500)
    }
  }

  // Saves the actual picture to the device — a plain browser download, same
  // fetch-then-blob the other two actions already use (Antonio, 2026-09-06:
  // "a button to save it local"). Named "Download" to match this codebase's
  // own established word for "export a copy" — "Save" already means
  // something else here (persist a record), confirmed by every other Save
  // button in this CRM (UX review, 2026-09-06).
  const handleDownload = async (captureId: string, title: string) => {
    if (downloadState === 'downloading') return
    setDownloadState('downloading')
    try {
      const res = await fetch(`/api/captures/${captureId}/image`)
      if (!res.ok) throw new Error('load failed')
      const blob = await res.blob()
      // See handleCopy's comment — only the side effect (the actual file
      // save) is skipped once stale; the state machine always resolves.
      if (openIdRef.current === captureId) {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = captureFileName(title)
        a.click()
        URL.revokeObjectURL(url)
      }
      setDownloadState('idle')
    } catch {
      setDownloadState('error')
      setTimeout(() => setDownloadState('idle'), 2500)
    }
  }

  // Opens the CRM's own "compose a new email" window with the picture
  // already attached — Antonio explicitly wants this to go through the
  // inbox already built into the CRM, not a generic device share sheet
  // ("we have our inbox in the CRM," 2026-09-06). Fetches first, THEN opens
  // the dialog with the file already in hand — ComposeDialog only stages
  // prefillFiles once per open session, so flipping it open before the
  // bytes exist would race that guard.
  const handleEmail = async (captureId: string, title: string) => {
    if (emailState === 'preparing') return
    setEmailState('preparing')
    try {
      const res = await fetch(`/api/captures/${captureId}/image`)
      if (!res.ok) throw new Error('load failed')
      const blob = await res.blob()
      // See handleCopy's comment — only the side effect (popping open the
      // email window) is skipped once stale; the state machine always
      // resolves, so reopening this capture later isn't refused forever.
      if (openIdRef.current === captureId) {
        const file = new File([blob], captureFileName(title), { type: blob.type })
        setEmailPayload({ file, subject: title })
      }
      setEmailState('idle')
    } catch {
      setEmailState('error')
      setTimeout(() => setEmailState('idle'), 2500)
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
            <div className="flex items-center justify-between gap-2 text-white">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{openCapture.title}</p>
                {openCapture.note && <p className="truncate text-xs text-zinc-300">{openCapture.note}</p>}
              </div>
              {/* Icon-only — four actions + Close no longer fit as icon+label
                  on the ~350px-wide lightbox this renders at on Antonio's
                  phone PWA without overflowing (UX review, 2026-09-06). The
                  FastTooltip label is the sighted-mouse convenience; aria-label
                  on each button carries the same words for anyone else. */}
              <div className="flex shrink-0 items-center gap-0.5">
                <FastTooltip label="Share">
                  <button
                    onClick={() => setSharingId(openCapture.id)}
                    className="rounded-full p-2 text-white hover:bg-white/10"
                    aria-label="Share"
                  >
                    <Send className="h-4 w-4" />
                  </button>
                </FastTooltip>
                <FastTooltip label={copyState === 'copying' ? 'Copying...' : copyState === 'copied' ? 'Copied' : copyState === 'error' ? 'Could not copy' : 'Copy'}>
                  <button
                    onClick={() => void handleCopy(openCapture.id)}
                    className="rounded-full p-2 text-white hover:bg-white/10"
                    aria-label="Copy picture"
                  >
                    {copyState === 'copied' ? <Check className="h-4 w-4" /> : copyState === 'error' ? <AlertCircle className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </button>
                </FastTooltip>
                <FastTooltip label={downloadState === 'downloading' ? 'Downloading...' : downloadState === 'error' ? 'Could not download' : 'Download'}>
                  <button
                    onClick={() => void handleDownload(openCapture.id, openCapture.title)}
                    className="rounded-full p-2 text-white hover:bg-white/10"
                    aria-label="Download picture"
                  >
                    {downloadState === 'error' ? <AlertCircle className="h-4 w-4" /> : <Download className="h-4 w-4" />}
                  </button>
                </FastTooltip>
                <FastTooltip label={emailState === 'preparing' ? 'Preparing...' : emailState === 'error' ? 'Could not prepare email' : 'Email'}>
                  <button
                    onClick={() => void handleEmail(openCapture.id, openCapture.title)}
                    className="rounded-full p-2 text-white hover:bg-white/10"
                    aria-label="Send by email"
                  >
                    {emailState === 'error' ? <AlertCircle className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
                  </button>
                </FastTooltip>
                <FastTooltip label="Close">
                  <button onClick={() => setOpenId(null)} className="rounded-full p-2 hover:bg-white/10" aria-label="Close">
                    <X className="h-5 w-5" />
                  </button>
                </FastTooltip>
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

      {/* z-[85]: above both the lightbox (z-[70]) and Share's own modal
          (z-[80]) it can be opened on top of — ComposeDialog's own default
          z-50 would otherwise render invisibly behind either one
          (bug-hunter finding, 2026-09-06). */}
      <ComposeDialog
        open={emailPayload !== null}
        onClose={() => setEmailPayload(null)}
        prefillSubject={emailPayload?.subject ?? ''}
        prefillFiles={emailPayload ? [emailPayload.file] : undefined}
        zIndexClassName="z-[85]"
      />

      {captures !== null && captures.length === 0 && (
        <div className="mt-16 flex flex-col items-center gap-2 text-zinc-300">
          <ImageOff className="h-10 w-10" />
        </div>
      )}
    </div>
  )
}
