/**
 * Client iPhone app, Chat: a tap on a message opens its action row (dev job 056a70d0, Antonio's phone test 12 Nov 2026).
 * The rule decides WHEN a tap counts (not when it was meant for a link, a button, a picture or a voice note inside the message, and not while
 * words are being selected) and which message has the row open afterwards.
 */
import { describe, it, expect } from 'vitest'
import { tapOpensActions, nextActionsFor, OWN_TAP_SELECTOR } from '@/lib/portal-app/chat-actions'
import { APP_FRAME_SLOT_ID, frameHasChatSlot } from '@/lib/portal-app/frame'

/** a fake element: `closest` answers yes when the element (or one above it) is one of the given tag names */
function el(inside: string[]) {
  return { closest: (selector: string) => (inside.some(tag => selector.split(',').map(s => s.trim()).includes(tag)) ? {} : null) }
}

describe('tapOpensActions', () => {
  it('opens on a plain tap on the message words', () => {
    expect(tapOpensActions(el([]), '')).toBe(true)
    expect(tapOpensActions(el([]), null)).toBe(true)
    expect(tapOpensActions(el([]), undefined)).toBe(true)
  })

  it('does not open when the tap was on something inside the message that handles its own tap', () => {
    for (const tag of ['a', 'button', 'audio', 'video', 'input', 'textarea', 'select', 'img', '[role="button"]', '[data-own-tap]']) {
      expect(tapOpensActions(el([tag]), ''), tag).toBe(false)
    }
  })

  it('does not open while words are selected (a long press selects text on iPhone)', () => {
    expect(tapOpensActions(el([]), 'some selected words')).toBe(false)
    expect(tapOpensActions(el([]), '   ')).toBe(true)   // only blanks selected = nothing really selected
  })

  it('never opens for a missing or odd target', () => {
    expect(tapOpensActions(null, '')).toBe(false)
    expect(tapOpensActions(undefined, '')).toBe(false)
    expect(tapOpensActions({}, '')).toBe(false)
  })

  it('knows every kind of thing that handles its own tap (a new kind must be added on purpose)', () => {
    expect(OWN_TAP_SELECTOR.split(',').map(s => s.trim()).sort()).toEqual(
      ['[data-own-tap]', '[role="button"]', 'a', 'audio', 'button', 'img', 'input', 'select', 'textarea', 'video'].sort(),
    )
  })
})

describe('nextActionsFor', () => {
  it('opens the tapped message when nothing is open', () => {
    expect(nextActionsFor(null, 'm1')).toBe('m1')
  })
  it('closes it when the same message is tapped again', () => {
    expect(nextActionsFor('m1', 'm1')).toBeNull()
  })
  it('moves the row to another message', () => {
    expect(nextActionsFor('m1', 'm2')).toBe('m2')
  })
})

describe('the top row spot the Chat fills with its Topic and refresh buttons', () => {
  it('exists on the Chat screens only', () => {
    expect(frameHasChatSlot('/portal/chat')).toBe(true)
    expect(frameHasChatSlot('/portal/chat/open')).toBe(true)
    expect(frameHasChatSlot('/portal/chat?topic=tax')).toBe(true)
    expect(frameHasChatSlot('/portal')).toBe(false)
    expect(frameHasChatSlot('/portal/invoices')).toBe(false)
    expect(frameHasChatSlot('/portal/chatter')).toBe(false)
  })
  it('has a stable id', () => {
    expect(APP_FRAME_SLOT_ID).toBe('app-frame-slot')
  })
})
