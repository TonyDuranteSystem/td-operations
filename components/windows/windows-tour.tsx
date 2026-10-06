'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowLeftRight, CheckCircle2, ChevronDown, ChevronUp, Loader2, MessageSquare, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { acquireTour, isAnyTourActive, releaseTour } from '@/lib/ui/tour-lock'
import { WINDOWS_MIN_VIEWPORT_WIDTH } from '@/lib/windows/window-model'
import { onWindowEvent } from '@/lib/windows/window-events'
import { useWindowsSnapshot } from '@/lib/windows/windows-store'
import {
  OPEN_FEEDBACK_EVENT, START_TOUR_EVENT, canOpenWindowNow, requestOpenWindow,
} from '@/lib/windows/windows-context'
import {
  STEPS, TOUR_VERSION, applyWindowEvent, detectPlatform, enterStep, fillKeys, isStepDone, keyNames, newProgress,
  precheck, ringSelector, type Precheck, type StepId, type TourProgress,
} from '@/lib/windows/tour-steps'
import { FEEDBACK_MAX, FEEDBACK_MIN, type FeedbackInput } from '@/lib/windows/tour-feedback'

/**
 * The guided tour of floating windows (dev job f3f3e237) — "learn by doing".
 *
 * NOT built on the WhatsApp tour's library on purpose: that one dims the whole screen, which would block the
 * very clicks this tour asks for (menus, dragging a window, the tab at the bottom) and cannot follow a window
 * that is being dragged. This is a small card in a corner plus a glowing ring around the thing to try; the
 * rest of the CRM stays fully usable. See docs/systems/dashboard-navigation.md.
 *
 * How a step works: it shows what the thing is, a real example from the person's day, and one thing to try. The
 * step finishes only when the window manager reports that the person REALLY did it (lib/windows/window-events.ts);
 * "Skip this step" is always there, so nobody is ever stuck. All the wording and rules are in
 * lib/windows/tour-steps.ts (pure, unit-tested).
 */

const LOCK = 'windows'
const STORE_PREFIX = 'td-windows-tour:'
const PROMPTED_PREFIX = 'td-windows-tour-prompted:'

type StepState = FeedbackInput['state']

function storage(kind: 'session' | 'local'): Storage | null {
  try {
    return kind === 'session' ? window.sessionStorage : window.localStorage
  } catch {
    return null
  }
}

export function WindowsTour({ userId }: { userId: string }) {
  const snapshot = useWindowsSnapshot()
  const pathname = usePathname()
  const keys = useMemo(
    () => keyNames(typeof navigator === 'undefined' ? 'other' : detectPlatform((navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform, navigator.userAgent)),
    [],
  )
  const platform = keys.opt.startsWith('Option') ? 'mac' : 'other'

  const [open, setOpen] = useState(false)
  const [standalone, setStandalone] = useState(false) // just the feedback box, no tour
  const [progress, setProgress] = useState<TourProgress>(newProgress)
  const [entry, setEntry] = useState<Precheck>({ kind: 'ok' })
  const [skipped, setSkipped] = useState<StepId[]>([])
  const [collapsed, setCollapsed] = useState(false)
  const [side, setSide] = useState<'right' | 'left'>('right')
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [narrow, setNarrow] = useState(false)
  const [plainClickNudge, setPlainClickNudge] = useState(false)

  const progressRef = useRef(progress)
  progressRef.current = progress
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const pathAtEntry = useRef<string | null>(null)

  const storeKey = `${STORE_PREFIX}${userId}`

  // ── start / stop ──
  const begin = useCallback((index = 0, resumed?: TourProgress) => {
    if (!acquireTour(LOCK)) {
      toast.error('Another tour is open. Finish it first, then start this one.')
      return
    }
    const base = resumed ?? newProgress()
    setProgress(enterStep(base, index))
    setSkipped([])
    setStandalone(false)
    setCollapsed(false)
    setFeedbackOpen(false)
    setOpen(true)
  }, [])

  const end = useCallback((finished: boolean) => {
    releaseTour(LOCK)
    setOpen(false)
    setStandalone(false)
    setFeedbackOpen(false)
    storage('session')?.removeItem(storeKey)
    // Remember it was seen, so the one-time prompt never comes back for someone who has been through it.
    try {
      storage('local')?.setItem(`${PROMPTED_PREFIX}${userId}`, finished ? 'done' : 'closed')
    } catch { /* storage blocked — the prompt may show again, harmless */ }
  }, [storeKey, userId])

  useEffect(() => {
    const onStart = () => {
      if (!canOpenWindowNow(true)) {
        toast.error('The tour needs a computer-size screen (about 1,000 pixels wide or more).')
        return
      }
      begin(0)
    }
    const onFeedback = () => {
      if (open) {
        setFeedbackOpen(true)
        return
      }
      setStandalone(true)
      setFeedbackOpen(true)
      setOpen(true)
    }
    document.addEventListener(START_TOUR_EVENT, onStart)
    document.addEventListener(OPEN_FEEDBACK_EVENT, onFeedback)
    return () => {
      document.removeEventListener(START_TOUR_EVENT, onStart)
      document.removeEventListener(OPEN_FEEDBACK_EVENT, onFeedback)
    }
  }, [begin, open])

  // Resume after a reload (e.g. the "new version" update): the step is kept for this browser tab.
  useEffect(() => {
    try {
      const raw = storage('session')?.getItem(storeKey)
      if (!raw) return
      const saved = JSON.parse(raw) as TourProgress
      if (typeof saved?.stepIndex !== 'number' || saved.stepIndex < 0 || saved.stepIndex >= STEPS.length) return
      if (canOpenWindowNow(true)) begin(saved.stepIndex, { ...saved, practiceId: null, opened: [] })
    } catch { /* corrupt or blocked storage — just don't resume */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, at start
  }, [])

  // Keep this browser tab's place, and give the lock back if the tour component goes away.
  useEffect(() => {
    if (open && !standalone) storage('session')?.setItem(storeKey, JSON.stringify({ stepIndex: progress.stepIndex }))
  }, [open, standalone, progress.stepIndex, storeKey])
  useEffect(() => () => releaseTour(LOCK), [])

  // ── what the person does to windows ──
  useEffect(() => {
    if (!open || standalone) return
    return onWindowEvent(ev => setProgress(p => applyWindowEvent(p, ev)))
  }, [open, standalone])

  // ── a step is entered: can it run? ──
  const step = STEPS[progress.stepIndex]
  useEffect(() => {
    if (!open || standalone) return
    const r = precheck(STEPS[progressRef.current.stepIndex], progressRef.current, snapshotRef.current)
    setEntry(r)
    if (r.kind === 'auto' && r.practiceId) setProgress(p => ({ ...p, practiceId: r.practiceId ?? p.practiceId }))
    pathAtEntry.current = window.location.pathname
    setPlainClickNudge(false)
    setFeedbackOpen(STEPS[progressRef.current.stepIndex].id === 'done')
  }, [open, standalone, progress.stepIndex])

  // The practice window disappeared mid-step (closed by hand): find another, or offer to open one.
  useEffect(() => {
    if (!open || standalone) return
    if (step.id !== 'move-resize' && step.id !== 'hide-restore') return
    if (isStepDone(step, progress, snapshot)) return
    const alive = progress.practiceId !== null && snapshot.ids.includes(progress.practiceId)
    if (alive) return
    const r = precheck(step, progress, snapshot)
    setEntry(r)
    if (r.kind === 'auto' && r.practiceId) setProgress(p => ({ ...p, practiceId: r.practiceId ?? p.practiceId }))
  }, [open, standalone, step, progress, snapshot])

  // The page behind changed to Leads by a plain click while we wait for an {OPT}-click.
  useEffect(() => {
    if (!open || standalone || step.id !== 'fast-way') return
    if (pathAtEntry.current !== null && pathname !== pathAtEntry.current && pathname.startsWith('/leads')) setPlainClickNudge(true)
  }, [open, standalone, step.id, pathname])

  // A narrow screen pauses the tour (windows can't be drawn there).
  useEffect(() => {
    if (!open) return
    const check = () => setNarrow(window.innerWidth < WINDOWS_MIN_VIEWPORT_WIDTH)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [open])

  const done = open && !standalone && (isStepDone(step, progress, snapshot) || entry.kind === 'auto')
  const selector = open && !standalone && !narrow && !(step.kind === 'act' && done) ? ringSelector(step, progress, snapshot) : null
  const [covered, setCovered] = useState(false)

  const goNext = () => {
    if (progress.stepIndex >= STEPS.length - 1) {
      end(true)
      return
    }
    setProgress(p => enterStep(p, p.stepIndex + 1))
  }
  const goBack = () => setProgress(p => enterStep(p, p.stepIndex - 1))
  const skip = () => {
    setSkipped(s => (s.includes(step.id) ? s : [...s, step.id]))
    goNext()
  }

  const stepState: StepState = standalone || step.kind === 'read'
    ? 'read'
    : skipped.includes(step.id) ? 'skipped'
    : entry.kind === 'auto' ? 'auto'
    : entry.kind === 'blocked' ? 'blocked'
    : done ? 'done' : 'waiting'

  if (!open) return <WindowsTourPrompt userId={userId} onStart={() => begin(0)} />

  return (
    <>
      <TourRing selector={selector} stepKey={`${step.id}:${progress.practiceId ?? ''}`} onCovered={setCovered} />
      <section
        role="region"
        aria-label="Floating windows tour"
        className={cn(
          'pointer-events-auto fixed bottom-4 z-[47] w-[22rem] max-w-[calc(100vw-2rem)] rounded-xl border border-emerald-300 bg-white text-zinc-800 shadow-2xl',
          side === 'right' ? 'right-4' : 'left-4',
        )}
      >
        {collapsed ? (
          <div className="flex items-center gap-2 px-3 py-2 text-sm">
            <span className="font-medium">Windows tour{standalone ? '' : ` — step ${progress.stepIndex + 1} of ${STEPS.length}`}</span>
            <button type="button" onClick={() => setCollapsed(false)} aria-label="Show the tour card" className="ml-auto rounded p-1 hover:bg-zinc-100">
              <ChevronUp className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => end(false)} aria-label="Close tour" className="rounded p-1 hover:bg-zinc-100">
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <div className="flex max-h-[min(34rem,calc(100vh-6rem))] flex-col">
            <div className="flex items-center gap-1 border-b border-emerald-100 bg-emerald-50 px-3 py-1.5 text-xs text-emerald-900">
              <span className="font-semibold">{standalone ? 'Tell us what is off' : `Step ${progress.stepIndex + 1} of ${STEPS.length}`}</span>
              <span className="ml-auto flex items-center">
                <button type="button" onClick={() => setSide(s => (s === 'right' ? 'left' : 'right'))} aria-label="Move the card to the other side" className="rounded p-1 hover:bg-emerald-100">
                  <ArrowLeftRight className="h-3.5 w-3.5" />
                </button>
                <button type="button" onClick={() => setCollapsed(true)} aria-label="Shrink the card" className="rounded p-1 hover:bg-emerald-100">
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
                <button type="button" onClick={() => end(false)} aria-label="Close tour" className="rounded p-1 hover:bg-emerald-100">
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            </div>

            <div className="space-y-2.5 overflow-y-auto px-4 py-3 text-sm leading-relaxed">
              {standalone ? (
                <p>Anything unclear, broken or missing with floating windows? Tell us in your own words.</p>
              ) : narrow ? (
                <>
                  <h3 className="text-[15px] font-bold">Paused</h3>
                  <p>Make this window at least 1,000 pixels wide to keep going. Windows can&apos;t be drawn on a narrower screen.</p>
                </>
              ) : (
                <StepBody
                  step={step}
                  entry={entry}
                  done={done}
                  stepState={stepState}
                  nudge={plainClickNudge}
                  covered={covered}
                  keys={keys}
                  progress={progress}
                  snapshotCount={snapshot.count}
                />
              )}

              {feedbackOpen ? (
                <FeedbackBox
                  step={standalone ? 'done' : step.id}
                  state={stepState}
                  platform={platform}
                  windowCount={snapshot.count}
                  onClose={() => {
                    setFeedbackOpen(false)
                    if (standalone) end(false)
                  }}
                />
              ) : (
                <button type="button" onClick={() => setFeedbackOpen(true)} className="inline-flex items-center gap-1 text-xs text-zinc-500 underline hover:text-zinc-800">
                  <MessageSquare className="h-3 w-3" />
                  Something off, or an idea?
                </button>
              )}
            </div>

            {!standalone && (
              <div className="flex items-center gap-2 border-t px-3 py-2">
                <button
                  type="button"
                  onClick={goBack}
                  disabled={progress.stepIndex === 0}
                  className="rounded-md px-2.5 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 disabled:opacity-30"
                >
                  Back
                </button>
                {step.kind === 'act' && !done && (
                  <button type="button" onClick={skip} className="rounded-md px-2.5 py-1.5 text-sm text-zinc-600 underline hover:bg-zinc-100">
                    Skip this step
                  </button>
                )}
                <button
                  type="button"
                  onClick={goNext}
                  disabled={!done && step.kind === 'act'}
                  className="ml-auto rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-40"
                >
                  {progress.stepIndex === STEPS.length - 1 ? 'Finish' : step.id === 'welcome' ? 'Start the tour' : 'Next'}
                </button>
              </div>
            )}
          </div>
        )}
      </section>
    </>
  )
}

/** The words of one step, with this person's own key names and what the tour is waiting for right now. */
function StepBody({
  step, entry, done, stepState, nudge, covered, keys, progress, snapshotCount,
}: {
  step: (typeof STEPS)[number]
  entry: Precheck
  done: boolean
  stepState: StepState
  nudge: boolean
  covered: boolean
  keys: { opt: string; cmd: string }
  progress: TourProgress
  snapshotCount: number
}) {
  const t = (s: string) => fillKeys(s, keys)
  const checklist = (step.id === 'move-resize' || step.id === 'hide-restore') && !done
  return (
    <>
      <h3 className="text-[15px] font-bold">{step.title}</h3>
      <p>{t(step.body)}</p>
      {step.example && (
        <p className="rounded-md bg-zinc-50 px-3 py-2 text-[13px] text-zinc-700">
          <span className="font-semibold">For example: </span>
          {t(step.example)}
        </p>
      )}
      {step.tryIt && (
        <p className="font-semibold text-emerald-900">
          Try it: <span className="font-normal text-zinc-800">{t(step.tryIt)}</span>
        </p>
      )}

      {step.kind === 'act' && (
        <div className="space-y-1.5" aria-live="polite">
          {entry.kind === 'auto' && <p className="text-[13px] text-zinc-700">{entry.note}</p>}
          {entry.kind === 'blocked' && <p className="text-[13px] text-amber-800">{entry.note}</p>}
          {entry.kind === 'missing' && (
            <div className="space-y-1.5">
              <p className="text-[13px] text-amber-800">The practice window was closed.</p>
              {entry.canOpen && snapshotCount < 3 && (
                <button type="button" onClick={() => requestOpenWindow('/accounts', 'Accounts')} className="rounded-md border border-emerald-600 px-2.5 py-1 text-sm font-medium text-emerald-800 hover:bg-emerald-50">
                  Open Accounts for me
                </button>
              )}
            </div>
          )}
          {nudge && !done && (
            <p className="text-[13px] text-amber-800">
              That opened the page here instead of in a window. No problem. Hold {keys.opt} and click Leads again.
            </p>
          )}
          {covered && !done && entry.kind === 'ok' && (
            <p className="text-[13px] text-amber-800">
              {step.id === 'fast-way'
                ? 'A window is covering the left menu. Drag it aside, or click Minimize on its dark bar, so you can reach Leads.'
                : 'Something is covering the circled spot. Move the window or this card aside.'}
            </p>
          )}
          {checklist ? (
            step.id === 'move-resize' ? (
              <ul className="space-y-0.5 text-[13px]">
                <li className={progress.flags.moved ? 'text-emerald-800' : 'text-zinc-600'}>{progress.flags.moved ? '✓ Moved it' : '○ Move it (drag the dark bar)'}</li>
                <li className={progress.flags.resized ? 'text-emerald-800' : 'text-zinc-600'}>{progress.flags.resized ? '✓ Resized it' : '○ Resize it (drag an edge or a corner)'}</li>
              </ul>
            ) : (
              <ul className="space-y-0.5 text-[13px]">
                <li className={progress.flags.minimized ? 'text-emerald-800' : 'text-zinc-600'}>{progress.flags.minimized ? '✓ Hid it' : '○ Hide it (click Minimize on the dark bar)'}</li>
                <li className={progress.flags.restored ? 'text-emerald-800' : 'text-zinc-600'}>{progress.flags.restored ? '✓ Brought it back' : '○ Bring it back (click the tab at the bottom)'}</li>
              </ul>
            )
          ) : done ? (
            <p className="flex items-start gap-1.5 text-[13px] font-medium text-emerald-800">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{entry.kind === 'auto' ? 'Done. Nothing more to do here.' : t(step.done ?? 'Done.')}</span>
            </p>
          ) : stepState === 'waiting' && entry.kind === 'ok' ? (
            <p className="flex items-start gap-1.5 text-[13px] text-zinc-600">
              <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 motion-safe:animate-spin" />
              <span>{t(step.waiting ?? '')}</span>
            </p>
          ) : null}
        </div>
      )}

      {step.more && (
        <ul className="list-disc space-y-1 pl-5 text-[13px] text-zinc-700">
          {step.more.map(m => <li key={m}>{t(m)}</li>)}
        </ul>
      )}
    </>
  )
}

/** The glowing ring around whatever the step points at. Follows it as it moves (a dragged window, a scrolled menu). */
function TourRing({ selector, stepKey, onCovered }: { selector: string | null; stepKey: string; onCovered: (covered: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const scrolledFor = useRef<string>('')

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (!selector) {
      el.style.display = 'none'
      onCovered(false)
      return
    }
    let raf = 0
    let last = ''
    let lastCovered = false
    const tick = () => {
      const target = document.querySelector(selector)
      if (!target) {
        if (last !== 'none') {
          el.style.display = 'none'
          last = 'none'
        }
      } else {
        // A target far down the left menu would otherwise be out of sight: bring it into view once per step.
        const key = `${stepKey}|${selector}`
        if (scrolledFor.current !== key) {
          scrolledFor.current = key
          ;(target as HTMLElement).scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
        }
        const r = target.getBoundingClientRect()
        const next = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`
        if (r.width < 1 || r.height < 1) {
          if (last !== 'none') {
            el.style.display = 'none'
            last = 'none'
          }
        } else if (next !== last) {
          last = next
          el.style.display = 'block'
          el.style.left = `${r.left - 4}px`
          el.style.top = `${r.top - 4}px`
          el.style.width = `${r.width + 8}px`
          el.style.height = `${r.height + 8}px`
        }
        // Is something (a window, the card) sitting on top of the circled spot, so it can't be clicked?
        if (r.width >= 1 && r.height >= 1) {
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
          const isCovered = !!top && !target.contains(top) && !top.contains(target)
          if (isCovered !== lastCovered) {
            lastCovered = isCovered
            onCovered(isCovered)
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [selector, stepKey, onCovered])

  return (
    <div
      ref={ref}
      aria-hidden
      data-tour-ring=""
      className="pointer-events-none fixed z-[48] hidden rounded-lg border-2 border-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.25)] motion-safe:animate-pulse"
    />
  )
}

/** "Something off, or an idea?" — one box, one Send. The note goes to the team channel with the step it came from. */
function FeedbackBox({
  step, state, platform, windowCount, onClose,
}: { step: StepId; state: StepState; platform: 'mac' | 'other'; windowCount: number; onClose: () => void }) {
  const [text, setText] = useState('')
  const [phase, setPhase] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [error, setError] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(timer.current), [])

  const send = async () => {
    if (phase !== 'idle') return
    const trimmed = text.trim()
    if (trimmed.length < FEEDBACK_MIN) {
      setError('Please write a few words so we can understand.')
      return
    }
    setPhase('sending')
    setError('')
    try {
      const payload: FeedbackInput = {
        text: trimmed, step, state, platform, viewportWidth: window.innerWidth, windowCount, tourVersion: TOUR_VERSION,
      }
      const res = await fetch('/api/team/windows-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not send your note. Please try again.')
      }
      setPhase('sent')
      timer.current = setTimeout(onClose, 2500)
    } catch (err) {
      setPhase('idle')
      setError(err instanceof Error && err.message ? err.message : 'Could not send your note. Please try again.')
    }
  }

  if (phase === 'sent') {
    return <p className="flex items-center gap-1.5 text-[13px] font-medium text-emerald-800"><CheckCircle2 className="h-4 w-4" />Thanks. Antonio and Luca will see this.</p>
  }
  return (
    <div className="space-y-1.5 rounded-md border border-zinc-200 p-2.5">
      <label htmlFor="windows-tour-feedback" className="text-xs font-semibold text-zinc-700">Something off, or an idea?</label>
      <textarea
        id="windows-tour-feedback"
        value={text}
        onChange={e => setText(e.target.value)}
        maxLength={FEEDBACK_MAX}
        rows={3}
        placeholder="What confused you, or what would make this better?"
        className="w-full resize-y rounded-md border border-zinc-300 px-2 py-1.5 text-sm outline-none focus:border-emerald-500"
      />
      <p className="text-[11px] text-zinc-500">We will include which step you are on. Nothing from your pages is sent.</p>
      {error && <p role="alert" className="text-[13px] text-red-700">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={send}
          disabled={phase === 'sending'}
          className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {phase === 'sending' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Send
        </button>
        <button type="button" onClick={onClose} disabled={phase === 'sending'} className="rounded-md px-2.5 py-1 text-sm text-zinc-600 hover:bg-zinc-100">
          Cancel
        </button>
      </div>
    </div>
  )
}

/**
 * One polite, one-time offer per person (per browser): "New: floating windows — take the 1-minute tour?".
 * Not a forced start — the feature is already live and people are mid-work. It waits until the person has been
 * on the page a while, is not typing, no other tour is open and no "new version" bar is showing; it never shows
 * to someone who already has windows open (they know them), and never when the browser can't remember that it
 * was shown (it would come back on every page load).
 */
function WindowsTourPrompt({ userId, onStart }: { userId: string; onStart: () => void }) {
  const snapshot = useWindowsSnapshot()
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const onStartRef = useRef(onStart)
  onStartRef.current = onStart

  useEffect(() => {
    const key = `${PROMPTED_PREFIX}${userId}`
    let tries = 0
    let timer: ReturnType<typeof setTimeout>
    const attempt = () => {
      try {
        const ls = storage('local')
        if (!ls || ls.getItem(key)) return
        // Can this browser remember? (Private mode throws on write.)
        ls.setItem(key, 'probe')
        ls.removeItem(key)
      } catch {
        return
      }
      const a = document.activeElement
      const typing = !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || (a as HTMLElement).isContentEditable)
      const blocked = isAnyTourActive() || typing || !!document.querySelector('[data-update-banner]') || !canOpenWindowNow(true) || !snapshotRef.current.ready
      if (snapshotRef.current.count > 0) return // already uses windows
      if (blocked) {
        if (++tries < 6) timer = setTimeout(attempt, 10_000)
        return
      }
      try {
        storage('local')?.setItem(key, 'shown')
      } catch {
        return
      }
      toast('New: floating windows', {
        description: "Open a second page on top of the one you're working on. Take the 1-minute tour?",
        duration: Infinity,
        action: { label: 'Show me', onClick: () => onStartRef.current() },
        cancel: { label: 'Not now', onClick: () => {} },
      })
    }
    timer = setTimeout(attempt, 10_000)
    return () => clearTimeout(timer)
  }, [userId])

  return null
}
