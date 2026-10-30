import { describe, expect, it } from 'vitest'
import { showUnreadBadge, talkSplit } from '@/lib/talk/layout'
import { TALK_BASE, TD_TALK_TAB } from '@/lib/talk/paths'

describe('talkSplit — the list stays on the left of a wide screen', () => {
  it('the standalone app splits at lg, the CRM tab at xl (the CRM menu takes width)', () => {
    expect(talkSplit(TALK_BASE, true).back).toBe('lg:hidden')
    expect(talkSplit(TD_TALK_TAB, true).back).toBe('xl:hidden')
    expect(talkSplit(TALK_BASE, true).listPane).toContain('lg:w-[340px]')
    expect(talkSplit(TD_TALK_TAB, true).listPane).toContain('xl:w-[340px]')
  })
  it('with a chat open: the list hides on a phone but stays on a wide screen; the chat always shows', () => {
    for (const base of [TALK_BASE, TD_TALK_TAB]) {
      const s = talkSplit(base, true)
      expect(s.listPane).toMatch(/hidden (lg|xl):flex/)
      expect(s.chatPane).toMatch(/\bflex\b/)
      expect(s.chatPane).not.toContain('hidden')
    }
  })
  it('with no chat open: the list fills a phone; a wide screen shows the empty note on the right', () => {
    for (const base of [TALK_BASE, TD_TALK_TAB]) {
      const s = talkSplit(base, false)
      expect(s.listPane).not.toContain('hidden')
      expect(s.chatPane).toMatch(/hidden (lg|xl):flex/)
      expect(s.emptyNote).toMatch(/hidden (lg|xl):flex/)
    }
  })
  it('never mixes the two breakpoints inside one answer', () => {
    expect(JSON.stringify(talkSplit(TALK_BASE, true))).not.toContain('xl:')
    expect(JSON.stringify(talkSplit(TD_TALK_TAB, false))).not.toMatch(/\blg:/)
  })
})

describe('showUnreadBadge', () => {
  it('shows a number for a chat with unread messages', () => { expect(showUnreadBadge(3, false, true)).toBe(true) })
  it('hides it for the open chat that is on screen, shows it when the window is behind', () => {
    expect(showUnreadBadge(3, true, true)).toBe(false)
    expect(showUnreadBadge(3, true, false)).toBe(true)
  })
  it('never shows zero, null or undefined', () => {
    expect(showUnreadBadge(0, false, true)).toBe(false)
    expect(showUnreadBadge(null, false, true)).toBe(false)
    expect(showUnreadBadge(undefined, false, true)).toBe(false)
  })
})
