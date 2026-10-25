'use client'

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePathname, useRouter } from 'next/navigation'
import { useLang, useT } from '@/components/marketing/lang-provider'
import { DONE, PREVIEW_TOURS, TARGETS, WELCOME, boldParts, type ResolvedStep, type TourKey } from '@/lib/marketing/tour'
import { roleLabel } from '@/lib/marketing/permission-labels'

interface Run { mode: 'own' | 'preview'; key: TourKey; steps: ResolvedStep[]; i: number; phase: 'welcome' | 'step' | 'done' }
interface TourCtx { start: () => void; startPreview: (key: TourKey) => void; hasTour: boolean; canPreview: boolean }

const Ctx = createContext<TourCtx>({ start: () => {}, startPreview: () => {}, hasTour: false, canPreview: false })
export const useTour = (): TourCtx => useContext(Ctx)

/** The first element of the first selector that exists on the screen (selectors are most precise first). */
function findTarget(selectors: readonly string[]): Element | null {
  for (const s of selectors) {
    const el = document.querySelector(s)
    if (el) return el
  }
  return null
}

const CARD_W = 340
const PAD = 6
/** Where the place in a running tour is kept while the page changes (a full page load, which the tour uses as a last resort to reach a screen, must not lose it). */
const SAVED_KEY = 'tdm_tour_run'
/** Above the lead-window dock (z 200) and the search list (z 300), so nothing can sit on top of the tour. */
const Z = { block: 'z-[400]', spot: 'z-[401]', card: 'z-[402]', bar: 'z-[403]' }

interface Saved { mode: 'own' | 'preview'; key: TourKey; i: number; phase: 'welcome' | 'step' | 'done' }

/**
 * TD Marketing — the guided tour (dev job 9aec66fa). A welcome card, then one card per step that lights the real button or area of the real screen and says what it is for, then an end card.
 * The tour moves between screens by itself (the provider lives in the workspace frame, so it keeps its place while the page changes). It starts by itself ONCE per person and tour (the server says
 * `autoStart`), is remembered when it is finished or skipped, and can always be opened again with the Tour button. An owner can PREVIEW another role's tour: nothing is saved then.
 * Escape means "not now": it closes the tour without remembering anything.
 */
export function TourProvider({ own, previews, autoStart, recordable, children }: {
  own: { key: TourKey; steps: ResolvedStep[] }
  previews: Partial<Record<TourKey, ResolvedStep[]>> | null
  autoStart: boolean
  recordable: boolean
  children: React.ReactNode
}) {
  const t = useT()
  const lang = useLang()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const [run, setRun] = useState<Run | null>(null)
  const [mounted, setMounted] = useState(false)
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const [cardH, setCardH] = useState(300)
  const nextRef = useRef<HTMLButtonElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const started = useRef(false)
  const runRef = useRef<Run | null>(null)
  runRef.current = run
  const routerRef = useRef(router)
  routerRef.current = router

  useEffect(() => { setMounted(true) }, [])

  const record = useCallback((key: TourKey, status: 'done' | 'skipped') => {
    if (!recordable) return
    // best effort: when it cannot be saved the tour simply starts again next time. keepalive: a click on Close followed at once by a navigation or sign-out must not cancel it.
    fetch('/api/marketing/tour', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tour: key, status }), keepalive: true }).catch(() => {})
  }, [recordable])

  const start = useCallback(() => {
    if (own.steps.length === 0) return
    setRun({ mode: 'own', key: own.key, steps: own.steps, i: 0, phase: 'welcome' })
  }, [own])
  const startPreview = useCallback((key: TourKey) => {
    const steps = previews?.[key]
    if (!steps || steps.length === 0) return
    setRun({ mode: 'preview', key, steps, i: 0, phase: 'welcome' })
  }, [previews])

  // a tour that was running when the page was loaded again (the last-resort navigation below) carries on where it was; otherwise the first time: the server says this person has not seen his tour
  useEffect(() => {
    if (started.current) return
    let saved: Saved | null = null
    try { saved = JSON.parse(window.sessionStorage.getItem(SAVED_KEY) ?? 'null') as Saved | null } catch { saved = null }
    if (saved && (saved.mode === 'own' || saved.mode === 'preview')) {
      const steps = saved.mode === 'own' ? (saved.key === own.key ? own.steps : undefined) : previews?.[saved.key]
      if (steps && steps.length > 0 && saved.i >= 0 && saved.i < steps.length && (saved.phase === 'welcome' || saved.phase === 'step' || saved.phase === 'done')) {
        started.current = true
        setRun({ mode: saved.mode, key: saved.key, steps, i: saved.i, phase: saved.phase })
        return
      }
    }
    if (autoStart && own.steps.length > 0) { started.current = true; start() }
  }, [autoStart, own, previews, start])

  // keep the place of a running tour (and forget it when the tour ends)
  useEffect(() => {
    try {
      if (run) window.sessionStorage.setItem(SAVED_KEY, JSON.stringify({ mode: run.mode, key: run.key, i: run.i, phase: run.phase } satisfies Saved))
      else window.sessionStorage.removeItem(SAVED_KEY)
    } catch { /* the place is only a convenience */ }
  }, [run])

  /** Finish (done) or Skip: remembered. Read from a ref, so nothing with a side effect runs inside a state updater (React runs those twice in development). */
  const close = useCallback((status: 'done' | 'skipped') => {
    const r = runRef.current
    if (r?.mode === 'own') record(r.key, status)
    setRun(null)
  }, [record])
  const exitPreview = useCallback(() => { setRun(null); routerRef.current.push('/marketing/team') }, [])

  const step = run && run.phase === 'step' ? run.steps[run.i] : null

  // Go to the step's screen. A page can lose a push (a redirect, a slow render), so: push now, push again after 3 s, and as a last resort load the page itself after 8 s (the place in the tour
  // is kept, see above). The person is never left on a card that talks about a screen he is not on.
  useEffect(() => {
    if (!step) return
    if (pathname === step.href || pathname.startsWith(`${step.href}/`)) return
    routerRef.current.push(step.href)
    const again = setTimeout(() => routerRef.current.push(step.href), 3000)
    const hard = setTimeout(() => { window.location.assign(step.href) }, 8000)
    return () => { clearTimeout(again); clearTimeout(hard) }
  }, [step, pathname])

  // find what to light (the screen may still be loading: look for a few seconds), then follow it as the page scrolls or resizes
  useEffect(() => {
    if (!step) { setRect(null); return }
    const on = pathname === step.href || pathname.startsWith(`${step.href}/`)
    if (!on) { setRect(null); return }
    const selectors = TARGETS[step.target] ?? ['h1']
    let el: Element | null = null
    let tries = 0
    let scrolled = false
    const measure = () => {
      // look again for a more precise target while the page is still filling in (the heading is only the last choice)
      const best = findTarget(selectors)
      if (best && best !== el) { el = best; scrolled = false }
      if (!el || !el.isConnected) { setRect(null); return }
      if (!scrolled) { scrolled = true; try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }) } catch { /* old browser */ } }
      const b = el.getBoundingClientRect()
      setRect({ left: b.left, top: b.top, width: b.width, height: b.height })
    }
    measure()
    const timer = setInterval(() => { tries++; measure(); if (tries > 40) clearInterval(timer) }, 250)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => { clearInterval(timer); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true) }
  }, [step, pathname])

  useEffect(() => { nextRef.current?.focus() }, [run?.phase, run?.i])
  // the card's real height, so it never runs off the bottom of a small screen
  useLayoutEffect(() => { const h = cardRef.current?.getBoundingClientRect().height; if (h && Math.abs(h - cardH) > 1) setCardH(h) }, [run?.phase, run?.i, rect, cardH])

  const goNext = useCallback(() => setRun(r => (r ? (r.phase === 'welcome' ? { ...r, phase: 'step', i: 0 } : r.phase === 'step' ? (r.i + 1 >= r.steps.length ? { ...r, phase: 'done' } : { ...r, i: r.i + 1 }) : r) : r)), [])
  const goBack = useCallback(() => setRun(r => (r && r.phase === 'step' ? (r.i === 0 ? { ...r, phase: 'welcome' } : { ...r, i: r.i - 1 }) : r)), [])

  useEffect(() => {
    if (!run) return
    const onKey = (e: KeyboardEvent) => {
      // Escape means "not now": it closes the tour WITHOUT remembering anything (only Skip and finishing do), so a reflex Esc does not cost a new person his tour
      if (e.key === 'Escape') { if (run.mode === 'preview') exitPreview(); else setRun(null); return }
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (e.key === 'ArrowRight') goNext()
      else if (e.key === 'ArrowLeft') goBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [run, exitPreview, goNext, goBack])

  const value = useMemo<TourCtx>(() => ({ start, startPreview, hasTour: own.steps.length > 0, canPreview: !!previews && PREVIEW_TOURS.some(k => (previews[k]?.length ?? 0) > 0) }), [start, startPreview, own, previews])

  let card: React.ReactNode = null
  if (run) {
    const w = WELCOME[lang]
    const d = DONE[lang]
    const total = run.steps.length
    const common = `fixed ${Z.card} max-h-[calc(100vh-24px)] overflow-auto rounded-xl border-2 border-teal-700 bg-white p-4 text-slate-900 shadow-2xl`
    const btn = 'rounded-lg border px-3 py-1.5 text-sm'
    const pri = 'rounded-lg bg-slate-900 px-3 py-1.5 text-sm text-white'
    const skip = () => (run.mode === 'preview' ? exitPreview() : close('skipped'))
    if (run.phase === 'welcome') {
      card = (
        <div ref={cardRef} role="dialog" aria-modal="true" aria-label={w.title} data-testid="tour-card" data-phase="welcome" className={`${common} left-1/2 top-1/2 w-[440px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2`}>
          <h3 className="mb-1 text-base font-semibold">{w.title}</h3>
          <p className="mb-3 text-sm">{w.body}</p>
          <div className="flex justify-end gap-2">
            <button type="button" className={btn} data-testid="tour-skip" onClick={skip}>{w.skip}</button>
            <button type="button" ref={nextRef} className={pri} data-testid="tour-next" onClick={goNext}>{w.start}</button>
          </div>
        </div>
      )
    } else if (run.phase === 'done') {
      card = (
        <div ref={cardRef} role="dialog" aria-modal="true" aria-label={d.title} data-testid="tour-card" data-phase="done" className={`${common} left-1/2 top-1/2 w-[440px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2`}>
          <h3 className="mb-1 text-base font-semibold">{d.title}</h3>
          <p className="mb-3 text-sm">{d.body}</p>
          <div className="flex justify-end">
            <button type="button" ref={nextRef} className={pri} data-testid="tour-close" onClick={() => (run.mode === 'preview' ? exitPreview() : close('done'))}>{d.close}</button>
          </div>
        </div>
      )
    } else if (step) {
      const vw = typeof window === 'undefined' ? 1200 : window.innerWidth
      const vh = typeof window === 'undefined' ? 800 : window.innerHeight
      const w2 = Math.min(CARD_W, vw - 24)
      let style: React.CSSProperties
      if (rect) {
        let x = rect.left + rect.width + 16
        let y = rect.top
        if (x + w2 > vw - 12) { x = Math.max(12, rect.left - w2 - 16) }
        if (x + w2 > vw - 12 || x < 12) { x = Math.min(Math.max(12, rect.left), vw - w2 - 12); y = rect.top + rect.height + 16 }
        // keep the whole card, buttons included, inside the window
        y = Math.min(Math.max(12, y), Math.max(12, vh - cardH - 12))
        style = { left: x, top: y, width: w2 }
      } else {
        style = { left: '50%', top: '50%', width: w2, transform: 'translate(-50%, -50%)' }
      }
      const here = pathname === step.href || pathname.startsWith(`${step.href}/`)
      card = (
        <div ref={cardRef} role="dialog" aria-modal="true" aria-label={step.title} data-testid="tour-card" data-phase="step" data-step={run.i + 1} className={common} style={style}>
          <div className="mb-2 flex gap-1" aria-hidden="true">{run.steps.map((_, k) => <i key={k} className={`h-2 w-2 rounded-full border ${k <= run.i ? 'bg-teal-700' : 'bg-slate-100'}`} />)}</div>
          <h3 className="mb-1 text-base font-semibold" data-testid="tour-title">{step.title}</h3>
          <p className="mb-3 text-sm">{boldParts(step.body).map((p, k) => (p.bold ? <b key={k}>{p.text}</b> : <span key={k}>{p.text}</span>))}</p>
          {!here && <p className="mb-2 text-xs text-slate-500" data-testid="tour-moving">{t('Opening the screen…')}</p>}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">{t('Step {n} of {total}', { n: run.i + 1, total })}</span>
            <span className="flex-1" />
            <button type="button" className={btn} data-testid="tour-skip" onClick={skip}>{t('Skip')}</button>
            <button type="button" className={btn} data-testid="tour-back" onClick={goBack}>{t('Back')}</button>
            <button type="button" ref={nextRef} className={pri} data-testid="tour-next" onClick={goNext}>{run.i + 1 >= total ? t('Finish') : t('Next')}</button>
          </div>
        </div>
      )
    }
  }

  const who = run && run.mode === 'preview' ? t(roleLabel(run.key)) : ''

  return (
    <Ctx.Provider value={value}>
      {children}
      {mounted && run && createPortal(
        <>
          {run.mode === 'preview' && (
            <div role="status" data-testid="tour-preview-bar" className={`fixed inset-x-0 top-0 ${Z.bar} flex items-center justify-between gap-3 border-b border-amber-300 bg-amber-100 px-4 py-2 text-sm text-amber-900`}>
              <span><b>{t('Preview')}</b> - {t('This is the tour shown to the role: {who}. You are not them: nothing is saved and nobody is told.', { who })}</span>
              <button type="button" className="rounded-lg border border-amber-300 bg-white px-3 py-1 text-sm" data-testid="tour-preview-exit" onClick={exitPreview}>{t('Back to my Team screen')}</button>
            </div>
          )}
          {/* blocks the page behind the tour; the lit area is a hole made by a huge shadow around it */}
          <div className={`fixed inset-0 ${Z.block}`} aria-hidden="true" style={rect && run.phase === 'step' ? undefined : { background: 'rgba(0,0,0,0.5)' }} />
          {rect && run.phase === 'step' && (
            <div aria-hidden="true" data-testid="tour-spot" className={`pointer-events-none fixed ${Z.spot} rounded-lg`}
              style={{ left: rect.left - PAD, top: rect.top - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2, boxShadow: '0 0 0 9999px rgba(0,0,0,0.5)', outline: '3px solid #f5b301', outlineOffset: 0 }} />
          )}
          {card}
        </>,
        document.getElementById('tdm-root') ?? document.body,
      )}
    </Ctx.Provider>
  )
}

/** The Tour button at the bottom of the workspace sidebar: opens the person's own tour again, any time. */
export function TourButton() {
  const t = useT()
  const { start, hasTour } = useTour()
  if (!hasTour) return null
  return (
    <button type="button" onClick={start} data-testid="tour-button" className="w-full rounded-lg border border-dashed border-teal-700 px-3 py-1.5 text-sm text-teal-800 hover:bg-teal-50">&#9654; {t('Tour')}</button>
  )
}

/** On the owner's Team screen: preview what each role is shown. Only when the frame supplied the tours (the owner). */
export function TourPreviewBox() {
  const t = useT()
  const { startPreview, canPreview } = useTour()
  if (!canPreview) return null
  return (
    <section data-testid="tour-preview-box" className="mt-6 rounded-xl border bg-white p-4">
      <h2 className="font-semibold">{t("See each role's tour")}</h2>
      <p className="mb-3 mt-1 text-sm text-slate-500">{t('A preview, so you know what each person is shown. It never starts by itself and nothing is saved.')}</p>
      <div className="flex flex-wrap gap-2">
        {PREVIEW_TOURS.map(k => (
          <button key={k} type="button" data-testid={`tour-preview-${k}`} onClick={() => startPreview(k)} className="rounded-lg border px-3 py-1.5 text-sm hover:bg-slate-50">{t(roleLabel(k))}</button>
        ))}
      </div>
    </section>
  )
}
