'use client'

/**
 * TD Communication Phase 7 — client disclaimer gate + cinematic logo reveal.
 *
 * Rendered on /portal/td-communication when the client's enrollment is at
 * concept_ready (gated) or approved. The concept image URLs are NEVER passed
 * from the server — they are fetched from GET /api/portal/td-communication/concept
 * only AFTER the disclaimer is accepted (the API enforces this too).
 *
 * Flow:
 *   concept_ready + not accepted  → disclaimer card → accept → reveal animation → gallery
 *   concept_ready + already accepted → gallery (no re-animation)
 *   approved                      → "approved" gallery, no action buttons
 *
 * The image is CSS-protected (no select / no drag / no context menu) — a
 * deterrent, not hard protection (a signed URL is always fetchable from devtools).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Loader2, ShieldCheck, Heart, MessageCircle, CheckCircle2, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'

type Locale = 'en' | 'it'

interface ConceptItem {
  id: string
  preview_url: string | null
  file_name: string
  version_number: number
}
interface ConceptGroup {
  concept_number: number
  items: ConceptItem[]
}

const PRESENT_DELAY_MS = 1500

const T = {
  en: {
    disclaimerTitle: 'One quick step before your reveal',
    accept: 'I understand and accept these terms',
    view: 'View My Brand Concept',
    presenting: 'Presenting your brand concept…',
    createdFor: (c: string) => `Created by TD Communication for ${c}`,
    concept: (n: number) => `Concept ${String.fromCharCode(64 + n)}`,
    love: 'I Love It',
    discuss: "Let's Discuss",
    approvedTitle: 'Your concept is approved!',
    approvedSub: "We're preparing your final files.",
    none: 'Your brand concept is being finalized — check back shortly.',
    error: 'Something went wrong. Please try again.',
  },
  it: {
    disclaimerTitle: 'Un passaggio veloce prima di scoprire il tuo brand',
    accept: 'Ho letto e accetto questi termini',
    view: 'Mostra il mio concept',
    presenting: 'Stiamo presentando il tuo concept…',
    createdFor: (c: string) => `Creato da TD Communication per ${c}`,
    concept: (n: number) => `Concept ${String.fromCharCode(64 + n)}`,
    love: 'Mi piace molto',
    discuss: 'Parliamone',
    approvedTitle: 'Il tuo concept è approvato!',
    approvedSub: 'Stiamo preparando i file finali.',
    none: 'Il tuo concept è in fase di finalizzazione — torna a trovarci a breve.',
    error: 'Qualcosa è andato storto. Riprova.',
  },
} as const

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function ConceptReveal({
  initialStatus,
  disclaimerAccepted,
  disclaimerText,
  companyName,
  locale,
}: {
  initialStatus: string
  disclaimerAccepted: boolean
  disclaimerText: string
  companyName: string
  locale: Locale
}) {
  const t = T[locale] ?? T.en
  const router = useRouter()

  const [status, setStatus] = useState(initialStatus)
  // phase: 'gate' (disclaimer) | 'presenting' (overlay) | 'shown'
  const [phase, setPhase] = useState<'gate' | 'presenting' | 'shown'>(
    disclaimerAccepted || initialStatus === 'approved' ? 'shown' : 'gate',
  )
  const [checked, setChecked] = useState(false)
  const [accepting, setAccepting] = useState(false)
  const [responding, setResponding] = useState<null | 'approve' | 'discuss'>(null)
  const [concepts, setConcepts] = useState<ConceptGroup[]>([])
  const [activeConcept, setActiveConcept] = useState(0)
  const [loadingConcepts, setLoadingConcepts] = useState(false)
  const [imgVisible, setImgVisible] = useState(false)
  const fetchedRef = useRef(false)

  const fetchConcepts = useCallback(async (): Promise<void> => {
    setLoadingConcepts(true)
    try {
      const res = await fetch('/api/portal/td-communication/concept')
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || t.error)
      }
      const data = await res.json()
      setConcepts(Array.isArray(data.concepts) ? data.concepts : [])
      if (typeof data.status === 'string') setStatus(data.status)
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : t.error)
    } finally {
      setLoadingConcepts(false)
    }
  }, [t])

  // When we are in the "shown" phase (already accepted or approved), load the
  // concepts once. The accept flow loads them itself during the animation.
  useEffect(() => {
    if (phase === 'shown' && !fetchedRef.current) {
      fetchedRef.current = true
      fetchConcepts().then(() => {
        // Trigger the fade/scale on the image after it's in the DOM.
        requestAnimationFrame(() => setImgVisible(true))
      })
    }
  }, [phase, fetchConcepts])

  const onAccept = useCallback(async () => {
    if (!checked || accepting) return
    setAccepting(true)
    try {
      const res = await fetch('/api/portal/td-communication/disclaimer', { method: 'POST' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || t.error)
      }
      fetchedRef.current = true
      const reduced = prefersReducedMotion()
      setPhase('presenting')
      // Kick the fetch + a minimum "presenting" dwell, then reveal.
      const fetchP = fetchConcepts()
      const delayP = new Promise<void>((r) => setTimeout(r, reduced ? 0 : PRESENT_DELAY_MS))
      await Promise.all([fetchP, delayP])
      setPhase('shown')
      requestAnimationFrame(() => setImgVisible(true))
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : t.error)
      setPhase('gate')
    } finally {
      setAccepting(false)
    }
  }, [checked, accepting, fetchConcepts, t])

  const respond = useCallback(async (decision: 'approve' | 'discuss') => {
    if (responding) return
    setResponding(decision)
    try {
      const res = await fetch('/api/portal/td-communication/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || t.error)
      }
      const data = await res.json()
      if (decision === 'discuss') {
        router.push(typeof data.redirect === 'string' ? data.redirect : '/portal/chat')
        return
      }
      if (typeof data.status === 'string') setStatus(data.status)
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : t.error)
    } finally {
      setResponding(null)
    }
  }, [responding, router, t])

  /* ----------------------------- Disclaimer gate ------------------------- */
  if (phase === 'gate') {
    return (
      <div className="mx-auto max-w-2xl px-4 sm:px-6 py-10">
        <div className="rounded-2xl border border-zinc-200 bg-white shadow-sm overflow-hidden">
          <div className="flex items-center gap-3 border-b border-zinc-100 bg-gradient-to-r from-zinc-50 to-white px-6 py-4">
            <ShieldCheck className="h-5 w-5 text-blue-600 shrink-0" />
            <h2 className="text-base font-semibold text-zinc-900">{t.disclaimerTitle}</h2>
          </div>
          <div className="px-6 py-5">
            <p className="text-sm leading-relaxed text-zinc-600 whitespace-pre-line">{disclaimerText}</p>
            <label className="mt-5 flex items-start gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => setChecked(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-zinc-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm font-medium text-zinc-800">{t.accept}</span>
            </label>
            <button
              onClick={onAccept}
              disabled={!checked || accepting}
              className={cn(
                'mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-white shadow-sm transition-colors',
                !checked || accepting ? 'bg-zinc-300 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700',
              )}
            >
              {accepting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {t.view}
            </button>
          </div>
        </div>
      </div>
    )
  }

  /* ----------------------------- Presenting overlay ----------------------- */
  if (phase === 'presenting') {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-zinc-950/90 backdrop-blur-sm animate-in fade-in duration-500">
        <Sparkles className="h-8 w-8 text-amber-300 animate-pulse" />
        <p className="text-lg font-medium text-white/90 tracking-wide">{t.presenting}</p>
      </div>
    )
  }

  /* ----------------------------- Reveal / gallery ------------------------- */
  const isApproved = status === 'approved'
  const group = concepts[activeConcept]
  const mainItem = group?.items?.[0] ?? null

  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-8">
      {isApproved && (
        <div className="mb-6 flex items-center justify-center gap-3 rounded-2xl border border-emerald-100 bg-emerald-50/70 px-6 py-4 text-center">
          <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />
          <p className="text-sm font-medium text-emerald-900">
            <span className="font-semibold">{t.approvedTitle}</span> {t.approvedSub}
          </p>
        </div>
      )}

      {/* Concept tabs (A / B / C) */}
      {concepts.length > 1 && (
        <div className="mb-4 flex items-center justify-center gap-2 flex-wrap">
          {concepts.map((c, i) => (
            <button
              key={c.concept_number}
              onClick={() => { setActiveConcept(i); setImgVisible(false); requestAnimationFrame(() => setImgVisible(true)) }}
              className={cn(
                'px-3 py-1.5 text-xs font-medium rounded-full border transition-colors',
                i === activeConcept
                  ? 'bg-blue-50 text-blue-700 border-blue-200'
                  : 'bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50',
              )}
            >
              {t.concept(c.concept_number)}
            </button>
          ))}
        </div>
      )}

      {/* The white card + logo */}
      <div className="rounded-3xl border border-zinc-200 bg-white shadow-md p-8 sm:p-12 flex flex-col items-center">
        {loadingConcepts ? (
          <div className="flex items-center justify-center py-16 text-zinc-300">
            <Loader2 className="h-7 w-7 animate-spin" />
          </div>
        ) : mainItem?.preview_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={mainItem.preview_url}
            alt="Brand concept"
            draggable={false}
            onContextMenu={(e) => e.preventDefault()}
            className={cn(
              'max-h-[420px] w-auto max-w-full object-contain select-none pointer-events-none transition-all duration-500 ease-out',
              imgVisible ? 'opacity-100 scale-100' : 'opacity-0 scale-95',
            )}
          />
        ) : (
          <p className="py-12 text-center text-sm text-zinc-400">{t.none}</p>
        )}
        {mainItem && (
          <p className="mt-6 text-sm font-medium text-zinc-500 text-center">{t.createdFor(companyName)}</p>
        )}
      </div>

      {/* Action buttons — only when there is a concept to act on and not yet approved */}
      {!isApproved && mainItem && (
        <div className="mt-6 flex flex-col sm:flex-row items-stretch justify-center gap-3">
          <button
            onClick={() => respond('approve')}
            disabled={responding !== null}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-emerald-700 disabled:opacity-50"
          >
            {responding === 'approve' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Heart className="h-4 w-4" />}
            {t.love}
          </button>
          <button
            onClick={() => respond('discuss')}
            disabled={responding !== null}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {responding === 'discuss' ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageCircle className="h-4 w-4" />}
            {t.discuss}
          </button>
        </div>
      )}
    </div>
  )
}
