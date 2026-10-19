import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { verifySvixSignature, interpretResendEvent, shouldApplyDelivery, deliveryReasonKey } from '@/lib/portal/resend-webhook'

const keyBytes = Buffer.from('super-secret-signing-key-for-tests')
const secret = `whsec_${keyBytes.toString('base64')}`
const sign = (id: string, ts: string, body: string) => `v1,${createHmac('sha256', keyBytes).update(`${id}.${ts}.${body}`).digest('base64')}`
const NOW = 1_800_000_000_000

describe('Svix signature check', () => {
  const body = '{"type":"email.bounced","data":{"email_id":"abc"}}'
  const ts = String(NOW / 1000)
  const ok = { secret, id: 'msg_1', timestamp: ts, signature: sign('msg_1', ts, body), payload: body, nowMs: NOW }

  it('accepts a correctly signed request', () => { expect(verifySvixSignature(ok)).toBe(true) })
  it('accepts when one of several signatures matches', () => {
    expect(verifySvixSignature({ ...ok, signature: `v1,AAAA ${sign('msg_1', ts, body)}` })).toBe(true)
  })
  it('rejects a changed body', () => { expect(verifySvixSignature({ ...ok, payload: body + ' ' })).toBe(false) })
  it('rejects a wrong secret', () => {
    expect(verifySvixSignature({ ...ok, secret: `whsec_${Buffer.from('another').toString('base64')}` })).toBe(false)
  })
  it('rejects a replay (timestamp too old or too far ahead)', () => {
    expect(verifySvixSignature({ ...ok, nowMs: NOW + 301_000 })).toBe(false)
    expect(verifySvixSignature({ ...ok, nowMs: NOW - 301_000 })).toBe(false)
    expect(verifySvixSignature({ ...ok, nowMs: NOW + 299_000 })).toBe(true)
  })
  it('rejects missing headers, an empty secret, a bad timestamp and other signature versions', () => {
    expect(verifySvixSignature({ ...ok, id: null })).toBe(false)
    expect(verifySvixSignature({ ...ok, timestamp: null })).toBe(false)
    expect(verifySvixSignature({ ...ok, signature: null })).toBe(false)
    expect(verifySvixSignature({ ...ok, secret: '' })).toBe(false)
    expect(verifySvixSignature({ ...ok, timestamp: 'abc' })).toBe(false)
    expect(verifySvixSignature({ ...ok, signature: ok.signature.replace('v1,', 'v2,') })).toBe(false)
  })
})

describe('what an event means', () => {
  const ev = (type: string, extra: Record<string, unknown> = {}) => ({ type, data: { email_id: 'em_1', ...extra } })
  it('maps delivery events', () => {
    expect(interpretResendEvent(ev('email.delivered'))).toEqual({ emailId: 'em_1', status: 'delivered', detail: null })
    expect(interpretResendEvent(ev('email.delivery_delayed'))).toEqual({ emailId: 'em_1', status: 'delayed', detail: 'delayed' })
    expect(interpretResendEvent(ev('email.suppressed'))).toEqual({ emailId: 'em_1', status: 'not_delivered', detail: 'suppressed' })
    expect(interpretResendEvent(ev('email.bounced'))).toEqual({ emailId: 'em_1', status: 'not_delivered', detail: 'bounced' })
    expect(interpretResendEvent(ev('email.failed'))).toEqual({ emailId: 'em_1', status: 'not_delivered', detail: 'failed' })
  })
  it('ignores events that say nothing about arrival', () => {
    for (const t of ['email.sent', 'email.opened', 'email.clicked', 'email.complained', 'email.scheduled', 'domain.updated', 'suppression.added']) {
      expect(interpretResendEvent(ev(t))).toBeNull()
    }
  })
  it('ignores malformed bodies', () => {
    expect(interpretResendEvent(null)).toBeNull()
    expect(interpretResendEvent('x')).toBeNull()
    expect(interpretResendEvent({ type: 'email.bounced' })).toBeNull()
    expect(interpretResendEvent({ type: 'email.bounced', data: {} })).toBeNull()
    expect(interpretResendEvent({ type: 'email.bounced', data: { email_id: '' } })).toBeNull()
    expect(interpretResendEvent({ type: 5, data: { email_id: 'x' } })).toBeNull()
  })
})

describe('which status may overwrite which (events arrive late, twice, or out of order)', () => {
  it('a failure always applies', () => {
    for (const cur of [null, 'delayed', 'delivered', 'not_delivered']) expect(shouldApplyDelivery(cur, 'not_delivered')).toBe(true)
  })
  it('delivered never erases a failure, but replaces nothing/delayed/delivered', () => {
    expect(shouldApplyDelivery('not_delivered', 'delivered')).toBe(false)
    for (const cur of [null, 'delayed', 'delivered']) expect(shouldApplyDelivery(cur, 'delivered')).toBe(true)
  })
  it('delayed only fills an empty status or repeats itself', () => {
    expect(shouldApplyDelivery(null, 'delayed')).toBe(true)
    expect(shouldApplyDelivery('delayed', 'delayed')).toBe(true)
    expect(shouldApplyDelivery('delivered', 'delayed')).toBe(false)
    expect(shouldApplyDelivery('not_delivered', 'delayed')).toBe(false)
  })
})

describe('reason shown to the client', () => {
  it('maps codes to the three plain texts', () => {
    expect(deliveryReasonKey('suppressed')).toBe('suppressed')
    expect(deliveryReasonKey('bounced')).toBe('bounced')
    expect(deliveryReasonKey('failed')).toBe('failed')
    expect(deliveryReasonKey(null)).toBe('failed')
    expect(deliveryReasonKey('something else')).toBe('failed')
  })
})
