import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { isHorizontalDrag, rowOffset, settleState, revealedSide, SWIPE_OPEN_PX } from '@/lib/portal-chats/row-swipe'

describe('row swipe rules', () => {
  it('a mostly-vertical drag is a scroll, a sideways one is a swipe', () => {
    expect(isHorizontalDrag(40, 5)).toBe(true)
    expect(isHorizontalDrag(40, 35)).toBe(false)
    expect(isHorizontalDrag(5, 0)).toBe(false)
  })
  it('the row never moves past the revealed buttons', () => {
    expect(rowOffset('closed', 500)).toBe(SWIPE_OPEN_PX)
    expect(rowOffset('closed', -500)).toBe(-SWIPE_OPEN_PX)
    expect(rowOffset('right', -30)).toBe(SWIPE_OPEN_PX - 30)
  })
  it('settles open past the snap distance, otherwise closes', () => {
    expect(settleState('closed', 60)).toBe('right')
    expect(settleState('closed', -60)).toBe('left')
    expect(settleState('closed', 30)).toBe('closed')
    expect(settleState('right', -120)).toBe('closed')
    expect(settleState('right', -10)).toBe('right')
  })
  it('right swipe shows the left pair, left swipe the right pair', () => {
    expect(revealedSide(20)).toBe('left')
    expect(revealedSide(-20)).toBe('right')
    expect(revealedSide(0)).toBeNull()
  })
})

describe('Portal Chats list wiring', () => {
  const page = readFileSync('app/(dashboard)/portal-chats/page.tsx', 'utf8')
  it('wraps each conversation row in the swipe row with the four actions', () => {
    expect(page).toContain('<SwipeRow')
    for (const k of ["key: 'read'", "key: 'unread'", "key: 'pin'", "key: 'note'", "key: 'link'"]) expect(page).toContain(k)
  })
  it('also wraps the open conversation header, with the same four tools', () => {
    expect(page).toContain('rowKey="open-header"')
    expect(page).toContain('openThreadSwipe.left')
    expect(page).toContain('openThreadSwipe.right')
    expect(page).toContain("className=\"app-hide shrink-0\"") // stays hidden in the phone-app shell like the header it wraps
  })
})
