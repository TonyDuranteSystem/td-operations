import { describe, it, expect } from 'vitest'
import { actionOrder, actionVerb, addAction, hasMyReaction, overlayActions, type ChatAction } from '@/lib/talk/outbox-actions-rules'
import type { TalkMessage } from '@/lib/talk/chat-model'

const base = { threadId: 't1', senderId: 'me', attempts: 0 }
const edit = (id: string, messageId: string, text: string, at = '2026-11-03T12:00:00.000Z'): ChatAction => ({ ...base, id, messageId, createdAt: at, kind: 'edit', text })
const del = (id: string, messageId: string, at = '2026-11-03T12:01:00.000Z'): ChatAction => ({ ...base, id, messageId, createdAt: at, kind: 'delete' })
const react = (id: string, messageId: string, emoji: string, on: boolean, at = '2026-11-03T12:02:00.000Z'): ChatAction => ({ ...base, id, messageId, createdAt: at, kind: 'react', emoji, on })
const msg = (id: string, extra: Partial<TalkMessage> = {}): TalkMessage => ({ id, sender_id: 'me', sender_name: 'Me', message: `text ${id}`, created_at: '2026-11-03T11:00:00.000Z', ...extra })
const me = { id: 'me', name: 'Me' }

describe('queued changes: collapsing', () => {
  it('a newer edit replaces an older edit of the same message', () => {
    const list = addAction(addAction([], edit('a', 'm1', 'one')), edit('b', 'm1', 'two'))
    expect(list.map(a => a.id)).toEqual(['b'])
  })

  it('a delete wins over every other change on that message, and nothing is added after it', () => {
    let list = addAction([], edit('a', 'm1', 'one'))
    list = addAction(list, react('r', 'm1', '👍', true))
    list = addAction(list, del('d', 'm1'))
    expect(list.map(a => a.id)).toEqual(['d'])
    expect(addAction(list, edit('e', 'm1', 'late')).map(a => a.id)).toEqual(['d'])
  })

  it('the latest wish for the same reaction replaces the earlier one; other reactions and other messages stay', () => {
    let list = addAction([], react('r1', 'm1', '👍', true))
    list = addAction(list, react('r2', 'm1', '❤️', true))
    list = addAction(list, react('r3', 'm2', '👍', true))
    list = addAction(list, react('r4', 'm1', '👍', false))
    expect(list.map(a => a.id).sort()).toEqual(['r2', 'r3', 'r4'])
  })

  it('applies changes oldest first', () => {
    const list = [del('d', 'm1', '2026-11-03T12:05:00.000Z'), edit('e', 'm2', 'x', '2026-11-03T12:01:00.000Z')]
    expect(actionOrder(list).map(a => a.id)).toEqual(['e', 'd'])
  })
})

describe('queued changes: what the screen shows', () => {
  it('an edit shows the new words and marks the message as waiting; other messages are untouched', () => {
    const [a, b] = overlayActions([msg('m1'), msg('m2')], [edit('a', 'm1', 'new words')], me)
    expect(a.message).toBe('new words')
    expect(a.edited_at).toBeTruthy()
    expect(a.pending).toBe(true)
    expect(b.pending).toBeUndefined()
    expect(b.message).toBe('text m2')
  })

  it('a delete marks the message deleted (the chat then hides it)', () => {
    const [a] = overlayActions([msg('m1')], [del('d', 'm1')], me)
    expect(a.deleted_at).toBeTruthy()
  })

  it('a reaction wish adds or removes MY reaction only', () => {
    const others = [{ emoji: '👍', reactor_id: 'lu', reactor_name: 'Luca' }]
    const [on] = overlayActions([msg('m1', { reactions: others })], [react('r', 'm1', '👍', true)], me)
    expect(on.reactions).toHaveLength(2)
    expect(hasMyReaction(on, '👍', 'me')).toBe(true)
    const mine = [...others, { emoji: '👍', reactor_id: 'me' }]
    const [off] = overlayActions([msg('m1', { reactions: mine })], [react('r', 'm1', '👍', false)], me)
    expect(off.reactions).toEqual(others)
    expect(hasMyReaction(off, '👍', 'me')).toBe(false)
  })

  it('does nothing when nothing is waiting, and hands back the very same list', () => {
    const list = [msg('m1')]
    expect(overlayActions(list, [], me)).toBe(list)
  })

  it('says what a refused change was', () => {
    expect(actionVerb({ kind: 'edit' })).toBe('save your edit')
    expect(actionVerb({ kind: 'delete' })).toBe('delete the message')
    expect(actionVerb({ kind: 'react' })).toBe('save your reaction')
  })
})
