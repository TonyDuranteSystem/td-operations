'use client'

/**
 * A short guided tour of the new email reply box (dev job 10b8dfce, Antonio 2026-10-06: "build a small tour for
 * Luca to know about this new feature"). Same pattern as the WhatsApp tour (react-joyride, the shared one-tour-at-a-time
 * lock): it highlights the REAL controls, one at a time, with a plain explanation and a Next button.
 *
 * Look-and-read only. It never types, ticks, sends, restores or discards anything for the person: the AI button would
 * call the AI on their text, the "open by default" tick-box changes a per-device setting, and Restore / Discard could
 * lose a draft they have not chosen to discard. The one thing it does is open the Expand pop-up (and close it again),
 * because the later steps point inside it; the text in the box is untouched either way.
 *
 * The reply box is told which state it needs through a window event (lib/inbox/reply-tour.ts). A step whose target is
 * missing (no email open, a narrow screen) is skipped rather than stalling the tour.
 */

import { useCallback, useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { ACTIONS, EVENTS, STATUS, type CallBackProps, type Step } from 'react-joyride'
import { acquireTour, releaseTour } from '@/lib/ui/tour-lock'
import { REPLY_TOUR_EVENT, endAction, transitionAction, type ReplyTourAction } from '@/lib/inbox/reply-tour'

const Joyride = dynamic(() => import('react-joyride'), { ssr: false })

// One entry per REPLY_TOUR_STEPS entry, in the same order (a unit test pins the pairing by id).
export const REPLY_TOUR_CONTENT: Array<Step & { id: string }> = [
  {
    id: 'box',
    target: '[data-tour="reply-box"]',
    title: 'Your reply box',
    content:
      "Write here as usual. ⌘+Enter (Ctrl+Enter on Windows) sends. Nothing goes out until you press Send, and pasted text keeps its blank lines.",
    disableBeacon: true,
    placement: 'top',
  },
  {
    id: 'toolbar',
    target: '[data-tour="reply-toolbar"]',
    title: 'Make it look right',
    content:
      'Select some words, then bold, italic, underline, a bulleted or numbered list, or a link. The client sees exactly this formatting.',
    placement: 'top',
  },
  {
    id: 'ai',
    target: '[data-tour="reply-ai"]',
    title: 'AI button — it fixes YOUR words',
    content:
      "With text in the box it only polishes what you wrote: wording and spelling, never new facts or prices. With an empty box it drafts a first reply from the email, so check every line. An Undo bar brings your own text back. It can't polish text that already has bold, lists or links.",
    placement: 'top',
  },
  {
    id: 'expand',
    target: '[data-tour="reply-expand"]',
    title: 'Need more room? Expand',
    content: "This opens a big window with the email on the left and your reply on the right. Press Next and we'll open it.",
    placement: 'top',
  },
  {
    id: 'popup-toolbar',
    target: '[data-tour="reply-toolbar"]',
    title: 'The full toolbar',
    content:
      'Here you also get colours, centring, undo and redo. Font, Size, Line and Gap apply to the whole email, not just the words you selected.',
    placement: 'bottom',
  },
  {
    id: 'popup-default',
    target: '[data-tour="reply-default"]',
    title: 'Always start here',
    content:
      'Tick this to open every reply straight in this window on this computer. We have not ticked it for you. Leave it off if you prefer the small box.',
    placement: 'top',
  },
  {
    id: 'safety',
    target: 'body',
    title: 'Your unsent reply is safe',
    content:
      'If the page refreshes or closes by mistake, a blue bar offers "Restore it" or "Discard" next time. Esc closes this window and your text stays in the small box. That is the whole tour. You can start it again from the Reply tour button.',
    placement: 'center',
  },
]

function sendReplyTour(action: ReplyTourAction | null) {
  if (action) window.dispatchEvent(new CustomEvent(REPLY_TOUR_EVENT, { detail: action }))
}

export function ReplyTour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [stepIndex, setStepIndex] = useState(0)
  const [run, setRun] = useState(false)

  useEffect(() => {
    if (open) {
      // One guided tour at a time (the WhatsApp and windows tours share this lock).
      if (!acquireTour('reply')) {
        onClose()
        return
      }
      setStepIndex(0)
      setRun(true)
    } else {
      releaseTour('reply')
      setRun(false)
    }
    return () => {
      releaseTour('reply')
      // Closed by leaving the page: give the reply box back its normal behaviour.
      sendReplyTour('release')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only `open` should restart it
  }, [open])

  const goTo = useCallback((from: number, to: number) => {
    const action = transitionAction(from, to)
    sendReplyTour(action)
    // The pop-up needs a moment to mount before the tour looks for a target inside it.
    window.setTimeout(() => setStepIndex(to), action === 'expand' ? 500 : action ? 200 : 0)
  }, [])

  const handleCallback = useCallback(
    (data: CallBackProps) => {
      const { status, type, action, index } = data

      const finish = () => {
        setRun(false)
        sendReplyTour(endAction(index))
        sendReplyTour('release')
        onClose()
      }

      if (status === STATUS.FINISHED || status === STATUS.SKIPPED) {
        finish()
        return
      }

      // A target that is not on screen (no reply box open, a hidden control) must never stall the tour.
      if (type === EVENTS.TARGET_NOT_FOUND) {
        const next = Math.min(index + 1, REPLY_TOUR_CONTENT.length - 1)
        if (next !== index) goTo(index, next)
        return
      }

      if (type === EVENTS.STEP_AFTER) {
        const next = action === ACTIONS.PREV ? Math.max(index - 1, 0) : index + 1
        // Done on the last step: in controlled mode Joyride does not end the tour itself.
        if (next >= REPLY_TOUR_CONTENT.length) {
          finish()
          return
        }
        goTo(index, next)
      }
    },
    [goTo, onClose],
  )

  if (!open) return null

  return (
    <Joyride
      steps={REPLY_TOUR_CONTENT}
      run={run}
      stepIndex={stepIndex}
      continuous
      showProgress
      showSkipButton
      scrollToFirstStep
      disableOverlayClose
      // Esc belongs to the pop-up (it closes it); the tour has its own Skip button.
      disableCloseOnEsc
      callback={handleCallback}
      locale={{ back: 'Back', close: 'Close', last: 'Done', next: 'Next', skip: 'Skip tour' }}
      styles={{
        options: {
          primaryColor: '#2563eb',
          zIndex: 10000,
          arrowColor: '#ffffff',
          backgroundColor: '#ffffff',
          textColor: '#1f2420',
        },
        tooltip: { borderRadius: 10, fontSize: 14 },
        tooltipTitle: { fontSize: 15, fontWeight: 700, marginBottom: 4 },
        buttonNext: { borderRadius: 6, fontSize: 13, fontWeight: 600 },
        buttonBack: { fontSize: 13 },
      }}
    />
  )
}
