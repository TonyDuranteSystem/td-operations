import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { MARKETING_CLIP_NAMES, TALK_CLIP_NAMES, clipNameKey, clipUrlFor, playClip, resetSoundProbe, soundAllowedWithoutClick } from '@/lib/voice-clips'
import { talkVoicePhrase, CLIENT_MESSAGE_PHRASE, TALK_FEATURE_PHRASE } from '@/lib/talk/voice-alert'
import { voicePhrases } from '@/lib/marketing/voice-alert'

describe('clipNameKey', () => {
  it('takes the first word, lower case, cut at a space or a dot', () => {
    expect(clipNameKey('Luca Degasper')).toBe('luca')
    expect(clipNameKey('antonio.durante')).toBe('antonio')
    expect(clipNameKey('  ROCCO ')).toBe('rocco')
    expect(clipNameKey(null)).toBe('')
  })
})

describe('clipUrlFor', () => {
  it('finds the TD Talk clip for a known person, however the name is written', () => {
    expect(clipUrlFor(talkVoicePhrase('Luca Degasper'))).toBe('/sounds/voice/talk-luca.mp3')
    expect(clipUrlFor(talkVoicePhrase('antonio.durante'))).toBe('/sounds/voice/talk-antonio.mp3')
    expect(clipUrlFor(talkVoicePhrase(''))).toBe('/sounds/voice/talk-team.mp3')
  })
  it('finds the fixed phrases', () => {
    expect(clipUrlFor(TALK_FEATURE_PHRASE)).toBe('/sounds/voice/talk-feature.mp3')
    expect(clipUrlFor(CLIENT_MESSAGE_PHRASE)).toBe('/sounds/voice/client-message.mp3')
    expect(clipUrlFor('Sound on')).toBe('/sounds/voice/sound-on.mp3')
  })
  it('finds the TD Marketing clips, and "someone" for a sender with no name', () => {
    expect(clipUrlFor(voicePhrases([{ sender: 'Rocco' }])[0])).toBe('/sounds/voice/from-rocco.mp3')
    expect(clipUrlFor(voicePhrases([{ sender: '' }])[0])).toBe('/sounds/voice/from-someone.mp3')
  })
  it('has no clip for a person nobody recorded (the browser voice is used then)', () => {
    expect(clipUrlFor(talkVoicePhrase('Imported from Slack'))).toBeNull()
    expect(clipUrlFor('Message from Giulia')).toBeNull()
    expect(clipUrlFor('something else entirely')).toBeNull()
  })
  it('every promised clip is a real file in public/sounds/voice', () => {
    const urls = [
      ...TALK_CLIP_NAMES.map(n => clipUrlFor(`New ${n} message in TD Talk`)),
      ...MARKETING_CLIP_NAMES.map(n => clipUrlFor(`Message from ${n}`)),
      clipUrlFor('Sound on'), clipUrlFor(TALK_FEATURE_PHRASE), clipUrlFor(CLIENT_MESSAGE_PHRASE),
      clipUrlFor('New team message in TD Talk'), clipUrlFor('Message from someone'),
    ]
    for (const u of urls) {
      expect(u).not.toBeNull()
      expect(existsSync(join(process.cwd(), 'public', u as string))).toBe(true)
    }
  })
})

describe('playClip', () => {
  afterEach(() => { vi.unstubAllGlobals(); resetSoundProbe() })
  const stubAudio = (play: () => Promise<void> | undefined) => {
    class A { listeners: Record<string, () => void> = {}; addEventListener(e: string, f: () => void) { this.listeners[e] = f } play() { return play() } }
    vi.stubGlobal('Audio', A)
  }
  it('calls the fallback when the browser refuses the clip', async () => {
    stubAudio(() => Promise.reject(new Error('NotAllowedError')))
    const fail = vi.fn()
    await playClip('/x.mp3', fail)
    expect(fail).toHaveBeenCalledTimes(1)
  })
  it('does not call the fallback when the clip starts and ends', async () => {
    let inst: { listeners: Record<string, () => void> } | null = null
    class A { listeners: Record<string, () => void> = {}; constructor() { inst = this } addEventListener(e: string, f: () => void) { this.listeners[e] = f } play() { return Promise.resolve() } }
    vi.stubGlobal('Audio', A)
    const fail = vi.fn()
    const done = playClip('/x.mp3', fail)
    await Promise.resolve()
    inst!.listeners.ended()
    await done
    expect(fail).not.toHaveBeenCalled()
  })
  it('falls back and does not throw when Audio is missing', async () => {
    vi.stubGlobal('Audio', undefined)
    const fail = vi.fn()
    await playClip('/x.mp3', fail)
    expect(fail).toHaveBeenCalledTimes(1)
  })
})

describe('soundAllowedWithoutClick', () => {
  afterEach(() => { vi.unstubAllGlobals(); resetSoundProbe() })
  it('is true when the browser lets the silent probe start, false when it refuses', async () => {
    vi.stubGlobal('Audio', class { play() { return Promise.resolve() } })
    expect(await soundAllowedWithoutClick()).toBe(true)
    resetSoundProbe()
    vi.stubGlobal('Audio', class { play() { return Promise.reject(new Error('NotAllowedError')) } })
    expect(await soundAllowedWithoutClick()).toBe(false)
  })
})
