import { describe, it, expect, afterEach } from 'vitest'
import { autoCallDoneEnabled, leadSendEnabled } from '@/lib/leads/flags'

const saved = { a: process.env.LEAD_AUTO_CALL_DONE, s: process.env.LEAD_WINDOW_SEND }
afterEach(() => {
  if (saved.a === undefined) delete process.env.LEAD_AUTO_CALL_DONE; else process.env.LEAD_AUTO_CALL_DONE = saved.a
  if (saved.s === undefined) delete process.env.LEAD_WINDOW_SEND; else process.env.LEAD_WINDOW_SEND = saved.s
})

describe('lead window kill switches', () => {
  it('both default OFF', () => {
    delete process.env.LEAD_AUTO_CALL_DONE
    delete process.env.LEAD_WINDOW_SEND
    expect(autoCallDoneEnabled()).toBe(false)
    expect(leadSendEnabled()).toBe(false)
  })
  it('only the exact value "true" turns one on', () => {
    for (const v of ['1', 'TRUE', 'yes', ' true', 'on', '']) {
      process.env.LEAD_AUTO_CALL_DONE = v
      process.env.LEAD_WINDOW_SEND = v
      expect(autoCallDoneEnabled()).toBe(false)
      expect(leadSendEnabled()).toBe(false)
    }
    process.env.LEAD_AUTO_CALL_DONE = 'true'
    process.env.LEAD_WINDOW_SEND = 'true'
    expect(autoCallDoneEnabled()).toBe(true)
    expect(leadSendEnabled()).toBe(true)
  })
})
