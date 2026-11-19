import { describe, it, expect } from 'vitest'
import { isDamagedAudioHead, claimedAudioKind } from '@/lib/media/audio-header'
import { findDamagedVoiceAttachment, DAMAGED_VOICE_MESSAGE } from '@/lib/team/voice-guard'

const bytes = (...v: number[]) => new Uint8Array(v)
const box = (type: string) => bytes(0, 0, 0, 28, ...type.split('').map(c => c.charCodeAt(0)), 0, 0, 0, 0, 0, 0, 0, 0)

describe('isDamagedAudioHead', () => {
  it('accepts a real MP4 (ftyp first)', () => expect(isDamagedAudioHead(box('ftyp'), 'audio/mp4')).toBe(false))
  it('accepts an MP4 whose index comes first', () => expect(isDamagedAudioHead(box('moov'), 'voice-note.m4a')).toBe(false))
  it('flags the headerless tail seen on 18 Nov 2026 (starts with moof)', () => expect(isDamagedAudioHead(box('moof'), 'audio/mp4')).toBe(true))
  it('flags a file too short to hold a header', () => expect(isDamagedAudioHead(bytes(0, 0, 0, 1), 'audio/mp4')).toBe(true))
  it('accepts WebM and flags a WebM without its header', () => {
    expect(isDamagedAudioHead(bytes(0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0), 'audio/webm')).toBe(false)
    expect(isDamagedAudioHead(bytes(0x43, 0xc3, 0x81, 0, 0, 0, 0, 0, 0, 0, 0, 0), 'audio/webm')).toBe(true)
  })
  it('never judges other kinds', () => {
    expect(isDamagedAudioHead(bytes(1, 2, 3), 'audio/mpeg')).toBe(false)
    expect(isDamagedAudioHead(bytes(), null)).toBe(false)
    expect(claimedAudioKind('image/png')).toBeNull()
  })
})

describe('findDamagedVoiceAttachment', () => {
  const att = { url: 'https://x.supabase.co/storage/v1/object/public/assets/team-chat/a/b.m4a', name: 'voice-note.m4a', mime_type: 'audio/mp4' }
  const reply = (b: Uint8Array, ok = true) => (async () => ({ ok, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) })) as unknown as typeof fetch
  it('refuses a damaged recording', async () => expect(await findDamagedVoiceAttachment([att], reply(box('moof')))).toBe(DAMAGED_VOICE_MESSAGE))
  it('lets a good recording through', async () => expect(await findDamagedVoiceAttachment([att], reply(box('ftyp')))).toBeNull())
  it('lets everything through when the file cannot be read', async () => {
    expect(await findDamagedVoiceAttachment([att], reply(box('moof'), false))).toBeNull()
    expect(await findDamagedVoiceAttachment([att], (async () => { throw new Error('net') }) as unknown as typeof fetch)).toBeNull()
  })
  it('ignores pictures and documents', async () => {
    let called = false
    const f = (async () => { called = true; return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) } }) as unknown as typeof fetch
    expect(await findDamagedVoiceAttachment([{ url: 'https://x/y.png', name: 'y.png', mime_type: 'image/png' }], f)).toBeNull()
    expect(called).toBe(false)
  })
})
