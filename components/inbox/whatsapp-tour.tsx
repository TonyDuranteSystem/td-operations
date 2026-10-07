'use client'

/**
 * A real, in-app guided tour of the WhatsApp inbox — not a document, not a mock-up of the
 * screen. It highlights the actual elements on the real page, one at a time, with a plain-
 * English explanation and a Next button, and moves on when the user clicks it.
 *
 * Antonio, 2026-10-01: "I mean something that will guide luca to go through every
 * functionalitis in the real app. a blinking dot or hand that explain what can do in a
 * specic place, then he clicks ok and move on the next one like a tour."
 *
 * Built on react-joyride (2.9.3, pinned) rather than hand-rolled spotlight/tooltip
 * positioning — a well-established, widely-used library for exactly this pattern, not
 * something worth re-solving ourselves (positioning, scrolling-into-view, mobile, keyboard).
 *
 * Every target is a real `data-tour="..."` attribute on the real control — see
 * inbox-shell.tsx, inbox-header.tsx, whatsapp-thread.tsx, whatsapp-contact-match-banner.tsx.
 * Content below mirrors exactly what the UX pass (2026-10-01, run against this same screen)
 * confirmed as the real behavior — including the parts that look like they do one thing but
 * do another (Delete, the two different "copy link" buttons, the bulk-match button acting
 * immediately).
 *
 * Several steps only make sense once a conversation is open (the match banner, copy-link,
 * Worker, composer, the per-message menu). If the user starts the tour from the bare list,
 * `onNeedOpenChat` is called once, right after the list step, to open the first real
 * conversation — same as clicking it themselves — so those later targets actually exist.
 */

import { useCallback, useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { ACTIONS, EVENTS, STATUS, type CallBackProps, type Step } from 'react-joyride'
import { acquireTour, releaseTour } from '@/lib/ui/tour-lock'

const Joyride = dynamic(() => import('react-joyride'), { ssr: false })

interface TourStep extends Step {
  /** After the user advances past this step, open the first conversation so later
   *  chat-specific targets exist — only needed once, right after the list step. */
  thenOpenFirstChat?: boolean
}

const STEPS: TourStep[] = [
  {
    target: '[data-tour="wa-tab"]',
    title: 'The WhatsApp tab',
    content: "Every real client WhatsApp conversation lives here, separate from email. The number shown is how many conversations are unread.",
    disableBeacon: true,
    placement: 'bottom',
  },
  {
    target: '[data-tour="wa-find-matches"]',
    title: 'Find matching clients',
    content: "Click this and it runs right away — it scans every WhatsApp conversation that isn't linked to a client yet and connects whatever it can by phone number. There's no confirmation step first.",
    placement: 'bottom',
  },
  {
    target: '[data-tour="wa-search"]',
    title: 'Search',
    content: 'Find a conversation fast by the client\'s name or their phone number.',
    placement: 'bottom',
  },
  {
    target: '[data-tour="wa-list"]',
    title: 'The conversation list',
    content: "Every chat lives here. On a real desktop screen this list stays visible even after you open one — click a conversation to open it on the right. We'll open one now so you can see what's inside.",
    placement: 'right',
    thenOpenFirstChat: true,
  },
  {
    target: '[data-tour="wa-match-banner"]',
    title: 'Is this a real client?',
    content: 'Green means this number is already linked to a client — nothing to do. If it says no match, click "Save this number" yourself; opening the chat never saves anyone automatically.',
    placement: 'bottom',
  },
  {
    target: '[data-tour="wa-copy-link"]',
    title: 'Share this conversation',
    content: "This copies a link to the whole conversation. Paste it anywhere — whoever opens it, if they're signed in here, lands straight in this exact chat. There's a second, separate \"Copy link\" inside a single message's own menu — that one points at just that one message.",
    placement: 'bottom',
  },
  {
    target: '[data-tour="wa-worker"]',
    title: 'Worker — AI assist',
    content: 'Worker already knows this client and this conversation. Ask it a question or for a draft reply — it never sends on its own. Any draft it offers lands in your message box, and you still press Send yourself.',
    placement: 'bottom',
  },
  {
    target: '[data-tour="wa-composer"]',
    title: 'Writing a reply',
    content: "Type here. There's also a mic for a voice note, a paperclip to attach a file, and an AI icon (a magic wand when you have typed something, a sparkle when the box is empty): with text in the box it polishes your wording (Undo brings your exact words back), with an empty box it suggests a reply from the chat.",
    placement: 'top',
  },
  {
    target: '[data-tour="wa-reply"]',
    title: 'Sending it',
    content: "Pressing this doesn't send right away — it opens one last screen showing exactly who it's going to and in what language, so you can check before it actually goes out.",
    placement: 'bottom',
  },
  {
    target: '[data-tour="wa-message-menu"]',
    title: 'Options on one message',
    content: 'Hover any message and click the three dots: reply to that exact line, tag it, pin it, react to it, or delete it. Delete only hides it from our side — it never touches what the client has on their own phone.',
    placement: 'left',
  },
]

export function WhatsAppTour({
  open,
  hasOpenChat,
  onNeedOpenChat,
  onClose,
}: {
  open: boolean
  /** Whether a WhatsApp conversation is currently open — tells the tour whether it needs to open one itself. */
  hasOpenChat: boolean
  /** Opens the first real conversation in the list, the same as a click would. */
  onNeedOpenChat: () => void
  onClose: () => void
}) {
  const [stepIndex, setStepIndex] = useState(0)
  const [run, setRun] = useState(false)

  useEffect(() => {
    if (open) {
      // Only one guided tour at a time (the floating-windows tour shares this lock). If the other tour is
      // open, this one simply does not start — the "Take the tour" button is always there to try again.
      if (!acquireTour('whatsapp')) {
        onClose()
        return
      }
      setStepIndex(0)
      setRun(true)
    } else {
      releaseTour('whatsapp')
      setRun(false)
    }
    return () => releaseTour('whatsapp')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onClose is stable enough; only `open` should restart it
  }, [open])

  const handleCallback = useCallback(
    (data: CallBackProps) => {
      const { status, type, action, index } = data

      if (status === STATUS.FINISHED || status === STATUS.SKIPPED) {
        setRun(false)
        onClose()
        return
      }

      // A target that doesn't exist yet (e.g. this conversation has no messages, so no
      // per-message menu to point at) must never stall the tour — skip past it.
      if (type === EVENTS.TARGET_NOT_FOUND) {
        setStepIndex((i) => Math.min(i + 1, STEPS.length - 1))
        return
      }

      if (type === EVENTS.STEP_AFTER) {
        const justFinished = STEPS[index]
        const next = action === ACTIONS.PREV ? Math.max(index - 1, 0) : index + 1

        if (action !== ACTIONS.PREV && justFinished?.thenOpenFirstChat && !hasOpenChat) {
          onNeedOpenChat()
          // Give the thread a beat to mount before Joyride looks for the next target.
          setTimeout(() => setStepIndex(next), 300)
          return
        }

        setStepIndex(next)
      }
    },
    [hasOpenChat, onNeedOpenChat, onClose]
  )

  if (!open) return null

  return (
    <Joyride
      steps={STEPS}
      run={run}
      stepIndex={stepIndex}
      continuous
      showProgress
      showSkipButton
      scrollToFirstStep
      disableOverlayClose
      callback={handleCallback}
      locale={{ back: 'Back', close: 'Close', last: 'Done', next: 'Next', skip: 'Skip tour' }}
      styles={{
        options: {
          primaryColor: '#1f8a5c',
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
