import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireMic, isStreamReusable, micErrorMessage, releaseMicNow, releaseMicSoon, resetMicSessionForTests, IDLE_RELEASE_MS } from '@/lib/media/mic-session'

function fakeStream(state: 'live' | 'ended' = 'live') {
  const track = { readyState: state, enabled: true, stop: vi.fn(() => { track.readyState = 'ended' }) }
  return { track, stream: { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream }
}

describe('mic-session', () => {
  let getUserMedia: ReturnType<typeof vi.fn>
  beforeEach(() => {
    vi.useFakeTimers()
    getUserMedia = vi.fn()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    vi.stubGlobal('document', { addEventListener: vi.fn(), visibilityState: 'visible' })
  })
  afterEach(() => { resetMicSessionForTests(); vi.useRealTimers(); vi.unstubAllGlobals() })

  it('asks the phone once and reuses the microphone for the next note', async () => {
    const a = fakeStream(); getUserMedia.mockResolvedValue(a.stream)
    const first = await acquireMic()
    releaseMicSoon()
    expect(a.track.enabled).toBe(false)
    const second = await acquireMic()
    expect(second).toBe(first)
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(a.track.enabled).toBe(true)
  })

  it('releases the microphone for real after the idle time', async () => {
    const a = fakeStream(); getUserMedia.mockResolvedValue(a.stream)
    await acquireMic(); releaseMicSoon()
    vi.advanceTimersByTime(IDLE_RELEASE_MS + 1)
    expect(a.track.stop).toHaveBeenCalled()
    const b = fakeStream(); getUserMedia.mockResolvedValue(b.stream)
    expect(await acquireMic()).toBe(b.stream)
    expect(getUserMedia).toHaveBeenCalledTimes(2)
  })

  it('asks again when the held microphone was ended by the phone', async () => {
    const a = fakeStream(); getUserMedia.mockResolvedValue(a.stream)
    await acquireMic(); a.track.readyState = 'ended'
    const b = fakeStream(); getUserMedia.mockResolvedValue(b.stream)
    expect(await acquireMic()).toBe(b.stream)
  })

  it('a new note within the idle time cancels the pending release', async () => {
    const a = fakeStream(); getUserMedia.mockResolvedValue(a.stream)
    await acquireMic(); releaseMicSoon()
    vi.advanceTimersByTime(IDLE_RELEASE_MS - 1000)
    await acquireMic()
    vi.advanceTimersByTime(5000)
    expect(a.track.stop).not.toHaveBeenCalled()
    releaseMicNow()
    expect(a.track.stop).toHaveBeenCalled()
  })

  it('isStreamReusable is false for nothing, no tracks, or an ended track', () => {
    expect(isStreamReusable(null)).toBe(false)
    expect(isStreamReusable({ getAudioTracks: () => [], getTracks: () => [] })).toBe(false)
    expect(isStreamReusable(fakeStream('ended').stream as never)).toBe(false)
    expect(isStreamReusable(fakeStream().stream as never)).toBe(true)
  })

  it('micErrorMessage tells blocked from busy from missing', () => {
    const e = (name: string) => Object.assign(new Error('x'), { name })
    expect(micErrorMessage(e('NotAllowedError')).blocked).toBe(true)
    expect(micErrorMessage(e('NotAllowedError')).message).toMatch(/Settings/)
    expect(micErrorMessage(e('NotFoundError')).message).toMatch(/No microphone/)
    expect(micErrorMessage(e('NotReadableError')).message).toMatch(/busy/)
    expect(micErrorMessage('weird').blocked).toBe(false)
  })
})
