/**
 * Floating chat window — the auto-open decision.
 *
 * Every case here is a specific failure the council found in the plan. If one of
 * these regresses, the window either pops when it must not (stealing focus,
 * showing a message the user then loses track of) or fails to pop for the one
 * message that mattered.
 */
import { describe, it, expect } from 'vitest'
import { decideAutoPop, type AutoPopInput } from '@/lib/team/chat-autopop'

const MY_DM = 'thread-dm-luca'
const base: AutoPopInput = {
  isDesktop: true,
  quiet: false,
  pathname: '/accounts',
  senderId: 'luca',
  myId: 'antonio',
  threadId: MY_DM,
  myDmThreadIds: new Set([MY_DM]),
  myConversationThreadIds: new Set(),
  overlayOpen: false,
  isTyping: false,
  openThreadId: null,
  minimized: false,
}
const decide = (over: Partial<AutoPopInput> = {}) => decideAutoPop({ ...base, ...over })

describe('decideAutoPop — the happy path', () => {
  it('opens for a DM from Luca while working elsewhere', () => {
    expect(decide()).toBe('open')
  })

  it('opens for an @mention even in a thread that is not mine', () => {
    expect(decide({ threadId: 'some-channel', mentionsMe: true, myDmThreadIds: new Set() })).toBe('open')
  })

  it('opens for a client conversation I take part in', () => {
    expect(decide({
      threadId: 'conv-1',
      myDmThreadIds: new Set(),
      myConversationThreadIds: new Set(['conv-1']),
    })).toBe('open')
  })

  it('opens on /portal-chats — the existing listener bails there, which is the bug', () => {
    expect(decide({ pathname: '/portal-chats' })).toBe('open')
  })
})

describe('decideAutoPop — identity races', () => {
  it('THE RACE: does not open while my own id is still resolving', () => {
    // A naive "senderId !== myId" test compares against null and passes, popping
    // a window for a message the user sent themselves from another tab.
    expect(decide({ myId: null })).toBe('ignore')
    expect(decide({ myId: undefined })).toBe('ignore')
  })

  it('never opens for my own message', () => {
    expect(decide({ senderId: 'antonio' })).toBe('ignore')
  })

  it('ignores a message with no thread', () => {
    expect(decide({ threadId: null })).toBe('ignore')
  })
})

describe('decideAutoPop — the brand-new conversation', () => {
  it('THE LOST FIRST MESSAGE: asks for a refresh instead of dropping an unknown thread', () => {
    // The DM-thread set is refreshed on a timer, so the first message of a new
    // conversation is not in it. Realtime replays nothing — dropping it here
    // means that message never surfaces at all.
    expect(decide({ threadId: 'brand-new-dm', myDmThreadIds: new Set() })).toBe('refresh')
  })

  it('gives up after one refresh so it cannot loop', () => {
    expect(decide({
      threadId: 'genuinely-not-mine',
      myDmThreadIds: new Set(),
      alreadyRefreshed: true,
    })).toBe('ignore')
  })

  it('opens once the refreshed set contains the new thread', () => {
    expect(decide({
      threadId: 'brand-new-dm',
      myDmThreadIds: new Set(['brand-new-dm']),
      alreadyRefreshed: true,
    })).toBe('open')
  })
})

describe('decideAutoPop — do not interrupt', () => {
  it('holds while a modal or drawer is open', () => {
    // Popping over steals focus mid-typing; popping under is invisible while
    // still counting as delivered. Both lose the message.
    expect(decide({ overlayOpen: true })).toBe('ignore')
  })

  it('holds while the user is typing', () => {
    expect(decide({ isTyping: true })).toBe('ignore')
  })

  it('respects the quiet toggle', () => {
    expect(decide({ quiet: true })).toBe('ignore')
  })

  it('never pops on mobile', () => {
    expect(decide({ isDesktop: false })).toBe('ignore')
  })

  it('stands down on the full chat page, which handles its own messages', () => {
    expect(decide({ pathname: '/team-chat' })).toBe('ignore')
    expect(decide({ pathname: '/team-chat/anything' })).toBe('ignore')
  })
})

describe('decideAutoPop — already open', () => {
  it('does not re-pop when already reading that conversation', () => {
    // Re-popping would yank the scroll position away from someone reading back.
    expect(decide({ openThreadId: MY_DM })).toBe('ignore')
  })

  it('DOES pop when open on that thread but minimized to the pill', () => {
    expect(decide({ openThreadId: MY_DM, minimized: true })).toBe('open')
  })

  it('pops when open on a different conversation', () => {
    expect(decide({ openThreadId: 'other-thread' })).toBe('open')
  })
})

describe('decideAutoPop — not for me', () => {
  it('ignores plain channel chatter after a refresh', () => {
    expect(decide({
      threadId: 'td-dev-channel',
      myDmThreadIds: new Set(),
      myConversationThreadIds: new Set(),
      alreadyRefreshed: true,
    })).toBe('ignore')
  })

  it('quiet and mobile still suppress a message that IS mine (the badge still moves)', () => {
    expect(decide({ quiet: true })).toBe('ignore')
    expect(decide({ isDesktop: false })).toBe('ignore')
  })
})
