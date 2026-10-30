import { describe, expect, it } from 'vitest'
import { IMPLEMENTATION_CHAT_TITLE, TALK_FEATURE_PHRASE, TALK_VOICE_KEY, isImplementationChat, shouldSpeakTalkPhrase, talkFirstName, talkVoiceIsOn, talkVoicePhrase } from '@/lib/talk/voice-alert'
import { readStatus } from '@/lib/talk/chat-model'

describe('talkVoicePhrase', () => {
  it('says the first name of the sender, in English', () => {
    expect(talkVoicePhrase('Luca Rossi')).toBe('New Luca message in TD Talk')
    expect(talkVoicePhrase('Antonio Durante')).toBe('New Antonio message in TD Talk')
  })
  it('says "team" when there is no name', () => {
    expect(talkVoicePhrase('')).toBe('New team message in TD Talk')
    expect(talkVoicePhrase(null)).toBe('New team message in TD Talk')
    expect(talkVoicePhrase('   ')).toBe('New team message in TD Talk')
  })
  it('first name handles extra spaces', () => { expect(talkFirstName('  Luca   R ')).toBe('Luca') })
})

describe('talkVoiceIsOn', () => {
  it('is on unless the person turned it off', () => {
    expect(talkVoiceIsOn(null)).toBe(true)
    expect(talkVoiceIsOn('on')).toBe(true)
    expect(talkVoiceIsOn('off')).toBe(false)
  })
  it('uses its own key, not Marketing\'s', () => { expect(TALK_VOICE_KEY).not.toBe('tdm_voice') })
})

describe('shouldSpeakTalkPhrase', () => {
  it('speaks the first time and for a different phrase', () => {
    expect(shouldSpeakTalkPhrase(null, 'a', 0)).toBe(true)
    expect(shouldSpeakTalkPhrase({ key: 'a', at: 0 }, 'b', 100)).toBe(true)
  })
  it('skips the same phrase inside the window, speaks it after', () => {
    expect(shouldSpeakTalkPhrase({ key: 'a', at: 0 }, 'a', 1_000)).toBe(false)
    expect(shouldSpeakTalkPhrase({ key: 'a', at: 0 }, 'a', 5_000)).toBe(true)
  })
})

describe('readStatus for a message Claude posted for a person', () => {
  it('leaves that person out as the writer', () => {
    const r = readStatus({ created_at: '2026-10-30T10:00:00Z', sender_id: 'claude', on_behalf_of_user_id: 'a' }, ['a', 'b', 'c'], { b: '2026-10-30T10:05:00Z' })
    expect(r).toEqual({ read: ['b'], waiting: ['c'] })
  })
})

describe('implementation chat', () => {
  it('is found by its name, ignoring case and spaces', () => {
    expect(isImplementationChat(IMPLEMENTATION_CHAT_TITLE)).toBe(true)
    expect(isImplementationChat('  new   IMPLEMENTATION ')).toBe(true)
    expect(isImplementationChat('TD Team Talk')).toBe(false)
    expect(isImplementationChat(null)).toBe(false)
  })
  it('has its own phrase', () => { expect(TALK_FEATURE_PHRASE).toBe('New feature posted in TD Talk') })
})

describe('readStatus', () => {
  const m = { created_at: '2026-10-30T10:00:00Z', sender_id: 'claude' }
  it('counts everyone but the sender, by their read pointer', () => {
    const r = readStatus(m, ['a', 'b', 'c'], { a: '2026-10-30T10:05:00Z', b: '2026-10-30T09:00:00Z' })
    expect(r.read).toEqual(['a'])
    expect(r.waiting).toEqual(['b', 'c'])
  })
  it('leaves the sender out when the sender is a member', () => {
    const r = readStatus({ ...m, sender_id: 'a' }, ['a', 'b'], { b: '2026-10-30T10:00:00Z' })
    expect(r).toEqual({ read: ['b'], waiting: [] })
  })
})
