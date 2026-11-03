import { describe, it, expect } from 'vitest'
import { draftKey, readDraft, writeDraft, MAX_DRAFT_CHARS, type DraftStorage } from '@/lib/talk/drafts'
import { lastMessagePreview, previewLine, titleWithCount, unreadTotal } from '@/lib/talk/list-preview'
import { leavingLosesRecording, stayAfterVoice } from '@/lib/talk/recording-guard'

function memoryStorage(): DraftStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: k => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => { data.set(k, v) },
    removeItem: k => { data.delete(k) },
  }
}

describe('drafts', () => {
  it('is one key per person and chat, and none without both', () => {
    expect(draftKey('u1', 'c1')).toBe('td-talk-draft:u1:c1')
    expect(draftKey('u1', 'c1')).not.toBe(draftKey('u2', 'c1'))
    expect(draftKey(null, 'c1')).toBeNull()
    expect(draftKey('u1', undefined)).toBeNull()
  })

  it('keeps what was typed and gives it back', () => {
    const s = memoryStorage()
    writeDraft('k', 'half a mess', s)
    expect(readDraft('k', s)).toBe('half a mess')
  })

  it('forgets the draft when the text is emptied or only spaces (a send empties the box)', () => {
    const s = memoryStorage()
    writeDraft('k', 'hello', s)
    writeDraft('k', '   \n ', s)
    expect(s.data.has('k')).toBe(false)
    expect(readDraft('k', s)).toBe('')
  })

  it('does nothing without a key or storage, and survives a storage that throws', () => {
    expect(readDraft(null, memoryStorage())).toBe('')
    expect(readDraft('k', null)).toBe('')
    const broken: DraftStorage = { getItem: () => { throw new Error('x') }, setItem: () => { throw new Error('x') }, removeItem: () => { throw new Error('x') } }
    expect(() => writeDraft('k', 'a', broken)).not.toThrow()
    expect(readDraft('k', broken)).toBe('')
  })

  it('cuts a draft that is longer than a message can be', () => {
    const s = memoryStorage()
    writeDraft('k', 'a'.repeat(MAX_DRAFT_CHARS + 50), s)
    expect(readDraft('k', s).length).toBe(MAX_DRAFT_CHARS)
  })
})

describe('chat list preview', () => {
  const members = [{ id: 'me', name: 'Antonio Durante' }, { id: 'lu', name: 'Luca Degasper' }, { id: 'jo', name: 'Jodi Smith' }]

  it('turns a message row into its short text', () => {
    expect(lastMessagePreview({ message: 'Ok  see you\nat 3', attachments: null, sender_id: 'lu' })).toBe('Ok see you at 3')
    expect(lastMessagePreview({ message: '', attachments: [{ url: 'u', name: 'note.m4a', mime_type: 'audio/mp4' }], sender_id: 'lu' })).toBe('🎤 Voice message')
    expect(lastMessagePreview({ message: '', attachments: [{ url: 'u', name: 'p.jpg', mime_type: 'image/jpeg' }], sender_id: 'lu' })).toBe('📷 Photo')
    expect(lastMessagePreview({ message: '', attachments: [{ url: 'u', name: 'invoice.pdf', mime_type: 'application/pdf' }], sender_id: 'lu' })).toBe('📎 invoice.pdf')
  })

  it('direct message: my words get "You:", theirs are just the words', () => {
    expect(previewLine({ thread_type: 'dm', last_message_preview: 'Ok', last_message_sender_id: 'me' }, 'me', members)).toBe('You: Ok')
    expect(previewLine({ thread_type: 'dm', last_message_preview: 'Ok', last_message_sender_id: 'lu' }, 'me', members)).toBe('Ok')
  })

  it('group: says who wrote it, by first name', () => {
    expect(previewLine({ thread_type: 'group', last_message_preview: 'Done', last_message_sender_id: 'lu' }, 'me', members)).toBe('Luca: Done')
    expect(previewLine({ thread_type: 'group', last_message_preview: 'Done', last_message_sender_id: 'me' }, 'me', members)).toBe('You: Done')
    expect(previewLine({ thread_type: 'group', last_message_preview: 'Done', last_message_sender_id: 'stranger' }, 'me', members)).toBe('Done')
  })

  it('is empty for a chat without a message', () => {
    expect(previewLine({ thread_type: 'dm', last_message_preview: null, last_message_sender_id: null }, 'me', members)).toBe('')
    expect(previewLine({ thread_type: 'dm' }, 'me', members)).toBe('')
  })
})

describe('unread count for the icon and tab', () => {
  const chats = [{ id: 'a', unread_count: 2 }, { id: 'b', unread_count: 3 }, { id: 'c', unread_count: 0 }, { id: 'd' }]

  it('adds up every chat', () => {
    expect(unreadTotal(chats, null, true)).toBe(5)
  })

  it('leaves out the open chat only while it is being looked at', () => {
    expect(unreadTotal(chats, 'b', true)).toBe(2)
    expect(unreadTotal(chats, 'b', false)).toBe(5)
  })

  it('puts the count in front of the title, or nothing', () => {
    expect(titleWithCount('TD Talk', 3)).toBe('(3) TD Talk')
    expect(titleWithCount('TD Talk', 0)).toBe('TD Talk')
    expect(titleWithCount('(3) TD Talk', 5)).toBe('(5) TD Talk')
    expect(titleWithCount('(5) TD Talk', 0)).toBe('TD Talk')
    expect(titleWithCount('TD Talk', 250)).toBe('(99+) TD Talk')
  })
})

describe('recording guard', () => {
  it('only a recording in progress is lost by leaving', () => {
    expect(leavingLosesRecording(true)).toBe(true)
    expect(leavingLosesRecording(false)).toBe(false)
  })

  it('only a note that was really kept lets the person leave after "Send it"', () => {
    expect(stayAfterVoice('sent')).toBe(false)
    expect(stayAfterVoice('failed')).toBe(true)
  })
})
