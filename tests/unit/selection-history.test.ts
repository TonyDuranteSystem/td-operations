import { describe, it, expect } from 'vitest'
import {
  serializeSelection,
  applySelectionToUrl,
  parseSelectionFromUrl,
} from '@/lib/hooks/use-selection-history'

const BASE = 'https://crm.example.com/portal-chats'

describe('serializeSelection', () => {
  it('is order-independent (same content → same signature)', () => {
    expect(serializeSelection({ a: '1', b: '2' })).toBe(serializeSelection({ b: '2', a: '1' }))
  })

  it('treats null, undefined and empty string as the same "absent"', () => {
    expect(serializeSelection({ a: null })).toBe(serializeSelection({ a: undefined }))
    expect(serializeSelection({ a: null })).toBe(serializeSelection({ a: '' }))
  })

  it('changes when a value changes — this is what triggers a history push', () => {
    expect(serializeSelection({ account: 'A' })).not.toBe(serializeSelection({ account: 'B' }))
  })

  it('distinguishes selected from cleared', () => {
    expect(serializeSelection({ account: 'A' })).not.toBe(serializeSelection({ account: null }))
  })
})

describe('applySelectionToUrl', () => {
  it('writes the owned keys', () => {
    const out = applySelectionToUrl(BASE, { account: 'acc-1', contact: null })
    expect(new URL(out).searchParams.get('account')).toBe('acc-1')
  })

  it('REMOVES a key when its value is cleared (no lingering ?account=)', () => {
    const out = applySelectionToUrl(`${BASE}?account=acc-1`, { account: null })
    expect(new URL(out).searchParams.has('account')).toBe(false)
  })

  it('removes on empty string too', () => {
    const out = applySelectionToUrl(`${BASE}?account=acc-1`, { account: '' })
    expect(new URL(out).searchParams.has('account')).toBe(false)
  })

  it('preserves query keys this page does not own', () => {
    const out = applySelectionToUrl(`${BASE}?message=m-9&account=old`, { account: 'new' })
    const sp = new URL(out).searchParams
    expect(sp.get('message')).toBe('m-9')
    expect(sp.get('account')).toBe('new')
  })

  it('preserves the pathname', () => {
    expect(new URL(applySelectionToUrl(BASE, { account: 'a' })).pathname).toBe('/portal-chats')
  })

  it('returns an identical href when nothing actually changes (guards a dead history entry)', () => {
    const start = `${BASE}?account=acc-1`
    expect(applySelectionToUrl(start, { account: 'acc-1' })).toBe(start)
  })

  it('switching chats swaps the value rather than appending a second one', () => {
    const out = applySelectionToUrl(`${BASE}?account=acc-1`, { account: 'acc-2' })
    expect(new URL(out).searchParams.getAll('account')).toEqual(['acc-2'])
  })

  it('handles several owned keys at once', () => {
    const out = applySelectionToUrl(`${BASE}?account=a1&thread=t1`, { account: null, thread: null, contact: 'c1' })
    const sp = new URL(out).searchParams
    expect(sp.has('account')).toBe(false)
    expect(sp.has('thread')).toBe(false)
    expect(sp.get('contact')).toBe('c1')
  })
})

describe('parseSelectionFromUrl', () => {
  it('reads owned keys, missing ones as null', () => {
    expect(parseSelectionFromUrl(`${BASE}?account=a1`, ['account', 'contact'])).toEqual({
      account: 'a1', contact: null,
    })
  })

  it('ignores keys it does not own', () => {
    expect(parseSelectionFromUrl(`${BASE}?account=a1&message=m1`, ['account'])).toEqual({ account: 'a1' })
  })

  it('round-trips with applySelectionToUrl', () => {
    const values = { account: 'a1', contact: null, thread: 't7' }
    const url = applySelectionToUrl(BASE, values)
    expect(parseSelectionFromUrl(url, ['account', 'contact', 'thread'])).toEqual({
      account: 'a1', contact: null, thread: 't7',
    })
  })

  it('a restored parse re-serializes to the same signature (this is what stops the push/pop loop)', () => {
    const values = { account: 'a1', contact: null }
    const url = applySelectionToUrl(BASE, values)
    const parsed = parseSelectionFromUrl(url, ['account', 'contact'])
    expect(serializeSelection(parsed)).toBe(serializeSelection(values))
  })
})
