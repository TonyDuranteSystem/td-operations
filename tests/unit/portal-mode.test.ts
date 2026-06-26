import { describe, it, expect } from 'vitest'
import { decidePortalMode } from '@/lib/portal/portal-mode'

describe('decidePortalMode', () => {
  it('dual-role (client + partner) defaults to client, honors the cookie', () => {
    expect(decidePortalMode({ partnerCapable: true, clientCapable: true, cookieMode: undefined }))
      .toEqual({ dual: true, mode: 'client' })
    expect(decidePortalMode({ partnerCapable: true, clientCapable: true, cookieMode: 'partner' }))
      .toEqual({ dual: true, mode: 'partner' })
    expect(decidePortalMode({ partnerCapable: true, clientCapable: true, cookieMode: 'client' }))
      .toEqual({ dual: true, mode: 'client' })
  })

  it('partner-only is locked to partner (cookie ignored)', () => {
    expect(decidePortalMode({ partnerCapable: true, clientCapable: false, cookieMode: 'client' }))
      .toEqual({ dual: false, mode: 'partner' })
  })

  it('client-only is locked to client (cookie ignored)', () => {
    expect(decidePortalMode({ partnerCapable: false, clientCapable: true, cookieMode: 'partner' }))
      .toEqual({ dual: false, mode: 'client' })
  })

  it('neither → client (safe default)', () => {
    expect(decidePortalMode({ partnerCapable: false, clientCapable: false, cookieMode: 'partner' }))
      .toEqual({ dual: false, mode: 'client' })
  })
})
