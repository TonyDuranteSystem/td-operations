import { describe, it, expect } from 'vitest'
import { teamChatMessageUrl } from '@/lib/talk/links'
import { talkUrlFor } from '@/lib/talk/paths'
import { decideJump, pendingJumpFromSearch, PENDING_JUMP_MAX_AGE_MS, type PendingJump } from '@/lib/talk/pending-jump'

describe('teamChatMessageUrl (the one shape of a TD Talk message link)', () => {
  it('carries the chat and the message', () => {
    expect(teamChatMessageUrl({ threadId: 't1', messageId: 'm1' })).toBe('/team-chat?thread=t1&message=m1')
  })
  it('keeps the thread root of a reply, root before message', () => {
    expect(teamChatMessageUrl({ threadId: 't1', rootId: 'r1', messageId: 'm1' })).toBe('/team-chat?thread=t1&root=r1&message=m1')
  })
  it('leaves out what is not there', () => {
    expect(teamChatMessageUrl({ threadId: 't1' })).toBe('/team-chat?thread=t1')
    expect(teamChatMessageUrl({ threadId: 't1', rootId: null, messageId: null })).toBe('/team-chat?thread=t1')
  })
  it('survives the web rewrite to /talk with the whole query (the service worker and the app share this rule)', () => {
    const url = teamChatMessageUrl({ threadId: 't1', rootId: 'r1', messageId: 'm1' })
    expect(talkUrlFor(url, 'https://app.example')).toBe('/talk?thread=t1&root=r1&message=m1')
  })
})

describe('pendingJumpFromSearch', () => {
  it('reads the chat and the message from the address', () => {
    expect(pendingJumpFromSearch('?thread=t1&message=m1', 5)).toEqual({ threadId: 't1', messageId: 'm1', at: 5 })
  })
  it('is nothing without a message', () => {
    expect(pendingJumpFromSearch('?thread=t1', 5)).toBeNull()
    expect(pendingJumpFromSearch('', 5)).toBeNull()
  })
  it('a message with no chat waits for whichever chat opens', () => {
    expect(pendingJumpFromSearch('?message=m1', 5)).toEqual({ threadId: null, messageId: 'm1', at: 5 })
  })
})

describe('decideJump (when a tapped alert may scroll to its message)', () => {
  const p: PendingJump = { threadId: 'B', messageId: 'm1', at: 1000 }
  const ready = { now: 2000, loadingMsgs: false, messageCount: 20, selectedId: 'B' }

  it('goes when the link\'s chat is open, loaded and not empty', () => {
    expect(decideJump(p, ready)).toBe('go')
  })
  it('does nothing when nothing is waiting', () => {
    expect(decideJump(null, ready)).toBe('none')
  })
  it('waits while ANOTHER chat is open — it must never jump inside the wrong chat', () => {
    expect(decideJump(p, { ...ready, selectedId: 'A' })).toBe('wait')
    expect(decideJump(p, { ...ready, selectedId: null })).toBe('wait')
  })
  it('waits while the chat is loading or still empty (opening a chat clears the old messages first)', () => {
    expect(decideJump(p, { ...ready, loadingMsgs: true })).toBe('wait')
    expect(decideJump(p, { ...ready, messageCount: 0 })).toBe('wait')
  })
  it('a link with no chat goes in whichever chat is open', () => {
    expect(decideJump({ ...p, threadId: null }, { ...ready, selectedId: 'Z' })).toBe('go')
  })
  it('forgets a link that never found its chat', () => {
    expect(decideJump(p, { ...ready, now: 1000 + PENDING_JUMP_MAX_AGE_MS + 1, selectedId: 'A' })).toBe('drop')
    expect(decideJump(p, { ...ready, now: 1000 + PENDING_JUMP_MAX_AGE_MS })).toBe('go')
  })
})
