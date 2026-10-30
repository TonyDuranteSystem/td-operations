import { describe, expect, it } from 'vitest'
import { KEEP_ALIVE_GAIN, KEEP_ALIVE_HZ, keepAliveWanted } from '@/lib/talk/keep-alive'
import { CLIENT_MESSAGE_PHRASE } from '@/lib/talk/voice-alert'

describe('keepAliveWanted', () => {
  it('runs only while Voice is On and the page has been touched', () => {
    expect(keepAliveWanted(true, true)).toBe(true)
    expect(keepAliveWanted(true, false)).toBe(false)
    expect(keepAliveWanted(false, true)).toBe(false)
    expect(keepAliveWanted(false, false)).toBe(false)
  })
})

describe('keep-alive tone', () => {
  it('is far below hearing at normal volume yet above Chrome\'s silence threshold (about -72 dBFS)', () => {
    const dbfs = 20 * Math.log10(KEEP_ALIVE_GAIN)
    expect(dbfs).toBeLessThan(-40)
    expect(dbfs).toBeGreaterThan(-72)
  })
  it('is a very low note', () => { expect(KEEP_ALIVE_HZ).toBeLessThanOrEqual(60) })
})

describe('client message phrase', () => {
  it('is generic — no company name', () => { expect(CLIENT_MESSAGE_PHRASE).toBe('New message from client') })
})
