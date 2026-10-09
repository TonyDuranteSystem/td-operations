'use client'

/**
 * A generic guided tour for the client portal (dev job 1a23f5f1): a one-time welcome prompt, then a pointer that
 * moves to the real controls, switching tabs when a step needs it. It only POINTS and EXPLAINS: it never types,
 * clicks, creates or sends anything for the person.
 *
 * Built on the same library and one-at-a-time lock as the staff tours (components/inbox/reply-tour.tsx). The steps
 * are DATA (resolved on the server from lib/portal/guides/guides.ts, with their wording already translated); this
 * component knows nothing about invoicing. A step whose marker is not on screen is skipped, never stalls the tour.
 *
 * Remembered per login: "Start" or "Skip" at the end saves `completed`; "Don't show again" saves `dismissed`;
 * "Not now" only snoozes it for this browser session. The "Take the tour" button is always there.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import { HelpCircle } from 'lucide-react'
import { ACTIONS, EVENTS, STATUS, type CallBackProps, type Step } from 'react-joyride'
import { acquireTour, releaseTour } from '@/lib/ui/tour-lock'
import { nextStepIndex, TOUR_EVENT_START, TOUR_EVENT_STATE, type TourStateEvent } from '@/lib/portal/guides/guides'

const Joyride = dynamic(() => import('react-joyride'), { ssr: false })

export interface GuidedTourStep {
  id: string
  /** The data-tour marker on the page. */
  target: string
  /** Switch to this tab (of the page at `basePath`) before looking for the marker. */
  tab?: string
  title: string
  body: string
  placement?: 'top' | 'bottom' | 'left' | 'right' | 'center'
}

export interface GuidedTourLabels {
  introTitle: string
  introBody: string
  start: string
  notNow: string
  dontShow: string
  takeTour: string
  next: string
  back: string
  skip: string
  done: string
}

const marker = (id: string) => `[data-tour="${id}"]`
const present = (id: string) => typeof document !== 'undefined' && !!document.querySelector(marker(id))

async function waitForMarker(id: string, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (present(id)) return true
    await new Promise(r => setTimeout(r, 120))
  }
  return false
}

export function GuidedTour({
  tourId, version, steps, labels, offer, basePath, activeTab,
}: {
  tourId: string
  version: number
  steps: GuidedTourStep[]
  labels: GuidedTourLabels
  /** The server decided this person has not been through this version and may be offered it. */
  offer: boolean
  /** Page the tabs belong to, e.g. /portal/invoices. */
  basePath: string
  activeTab: string
}) {
  const router = useRouter()
  const [introOpen, setIntroOpen] = useState(false)
  const [run, setRun] = useState(false)
  const [stepIndex, setStepIndex] = useState(0)
  const tabRef = useRef(activeTab)
  tabRef.current = activeTab
  const lockName = `portal-${tourId}`
  const snoozeKey = `td-tour-snooze-${tourId}-v${version}`

  // The slim "New: take the tour" banner listens to these, so it disappears the moment the tour starts or ends.
  const announce = useCallback((state: TourStateEvent) => {
    try { window.dispatchEvent(new CustomEvent(TOUR_EVENT_STATE, { detail: { tourId, state } })) } catch { /* no-op */ }
  }, [tourId])

  useEffect(() => {
    if (!offer) return
    let snoozed = false
    try { snoozed = window.sessionStorage.getItem(snoozeKey) === '1' } catch { /* storage unavailable: just show it */ }
    if (!snoozed) setIntroOpen(true)
  }, [offer, snoozeKey])

  useEffect(() => () => releaseTour(lockName), [lockName])

  const save = useCallback(async (status: 'completed' | 'dismissed') => {
    try {
      const res = await fetch('/api/portal/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: `tour.${tourId}`, value: { status, version } }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        console.warn('Could not remember the tour choice:', d.error || res.status)
      }
    } catch (err) {
      console.warn('Could not remember the tour choice:', err)
    }
  }, [tourId, version])

  const finish = useCallback((remember: boolean) => {
    setRun(false)
    releaseTour(lockName)
    if (remember) void save('completed')
    announce('finished')
  }, [lockName, save, announce])

  // A step is available if its marker is on screen now, or if it names a tab we can switch to first.
  const isAvailable = useCallback((i: number) => !!steps[i].tab || present(steps[i].target), [steps])

  // Show step `to`: switch tab first if the step needs another one, wait for its marker, then show it.
  const goTo = useCallback(async (to: number) => {
    const step = steps[to]
    if (!step) { finish(true); return }
    setRun(false)
    if (step.tab && step.tab !== tabRef.current) {
      router.push(`${basePath}?tab=${step.tab}`)
    }
    const ok = await waitForMarker(step.target)
    if (!ok) {
      // Marker never appeared: move on in the same direction rather than stall.
      const next = nextStepIndex(to, 1, steps.length, isAvailable)
      if (next === null) { finish(true); return }
      void goTo(next)
      return
    }
    // Bring the target into view ourselves: the portal scrolls inside its own page container, and letting the
    // tour library scroll the whole document shifts the entire layout.
    document.querySelector(marker(step.target))?.scrollIntoView({ block: 'center', inline: 'nearest' })
    await new Promise(r => setTimeout(r, 250))
    setStepIndex(to)
    setRun(true)
  }, [steps, basePath, router, finish, isAvailable])

  const start = useCallback(() => {
    if (!acquireTour(lockName)) return // another tour is on screen
    setIntroOpen(false)
    announce('started')
    void goTo(0)
  }, [lockName, goTo, announce])

  // The banner's button asks this tour to start (same as pressing "Take the tour").
  useEffect(() => {
    const onStart = (e: Event) => {
      const d = (e as CustomEvent<{ tourId: string }>).detail
      if (d && d.tourId === tourId) start()
    }
    window.addEventListener(TOUR_EVENT_START, onStart)
    return () => window.removeEventListener(TOUR_EVENT_START, onStart)
  }, [tourId, start])

  const handleCallback = useCallback((data: CallBackProps) => {
    const { status, type, action, index } = data
    if (status === STATUS.FINISHED || status === STATUS.SKIPPED) { finish(true); return }
    if (type === EVENTS.TARGET_NOT_FOUND) {
      const dir = action === ACTIONS.PREV ? -1 : 1
      const next = nextStepIndex(index, dir, steps.length, isAvailable)
      if (next === null) finish(true); else void goTo(next)
      return
    }
    if (type === EVENTS.STEP_AFTER) {
      if (action === ACTIONS.CLOSE) { finish(true); return }
      const dir = action === ACTIONS.PREV ? -1 : 1
      const next = nextStepIndex(index, dir, steps.length, isAvailable)
      if (next === null) {
        if (dir === 1) finish(true)
        return
      }
      void goTo(next)
    }
  }, [steps, finish, goTo, isAvailable])

  const joyrideSteps: Step[] = steps.map(s => ({
    target: s.placement === 'center' ? 'body' : marker(s.target),
    title: s.title,
    content: s.body,
    placement: s.placement ?? 'bottom',
    disableBeacon: true,
  }))

  return (
    <>
      <button
        type="button"
        onClick={start}
        data-testid="take-tour"
        className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
      >
        <HelpCircle className="h-4 w-4" />
        {labels.takeTour}
      </button>

      {introOpen && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4" data-testid="tour-intro">
          <div className="absolute inset-0 bg-black/40" aria-hidden="true" />
          <div role="dialog" aria-modal="true" aria-labelledby="tour-intro-title" className="relative w-full max-w-sm rounded-xl bg-white p-6 shadow-xl space-y-4">
            <h2 id="tour-intro-title" className="text-lg font-semibold text-zinc-900">{labels.introTitle}</h2>
            <p className="text-sm text-zinc-600">{labels.introBody}</p>
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => { setIntroOpen(false); void save('dismissed'); announce('dismissed') }}
                className="rounded-lg px-3 py-2 text-sm text-zinc-500 hover:bg-zinc-100"
              >
                {labels.dontShow}
              </button>
              <button
                type="button"
                onClick={() => {
                  setIntroOpen(false)
                  try { window.sessionStorage.setItem(snoozeKey, '1') } catch { /* ignore */ }
                }}
                className="rounded-lg border px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
              >
                {labels.notNow}
              </button>
              <button
                type="button"
                autoFocus
                onClick={start}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                {labels.start}
              </button>
            </div>
          </div>
        </div>
      )}

      <Joyride
        steps={joyrideSteps}
        run={run}
        stepIndex={stepIndex}
        continuous
        showProgress
        showSkipButton
        disableScrolling
        disableOverlayClose
        callback={handleCallback}
        locale={{ back: labels.back, close: labels.done, last: labels.done, next: labels.next, skip: labels.skip }}
        styles={{
          options: { primaryColor: '#2563eb', zIndex: 10000, arrowColor: '#ffffff', backgroundColor: '#ffffff', textColor: '#1f2420' },
          tooltip: { borderRadius: 10, fontSize: 14 },
          tooltipTitle: { fontSize: 15, fontWeight: 700, marginBottom: 4 },
          buttonNext: { borderRadius: 6, fontSize: 13, fontWeight: 600 },
          buttonBack: { fontSize: 13 },
        }}
      />
    </>
  )
}
