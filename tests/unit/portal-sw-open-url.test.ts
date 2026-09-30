import { describe, it, expect } from 'vitest'
import { portalUrlFromSwMessage } from '@/lib/portal/sw-scope'

const O = 'https://portal.tonydurante.us'

describe('portalUrlFromSwMessage (push tap → open window fallback)', () => {
  it('follows a same-origin portal chat link', () => {
    expect(portalUrlFromSwMessage({ type: 'PORTAL_OPEN_URL', url: `${O}/portal/chat/open?chatlink=1&account=personal` }, O))
      .toBe(`${O}/portal/chat/open?chatlink=1&account=personal`)
    expect(portalUrlFromSwMessage({ type: 'PORTAL_OPEN_URL', url: '/portal/sign' }, O)).toBe(`${O}/portal/sign`)
  })
  it('ignores other message types and malformed data', () => {
    expect(portalUrlFromSwMessage({ type: 'SKIP_WAITING' }, O)).toBeNull()
    expect(portalUrlFromSwMessage(null, O)).toBeNull()
    expect(portalUrlFromSwMessage('PORTAL_OPEN_URL', O)).toBeNull()
    expect(portalUrlFromSwMessage({ type: 'PORTAL_OPEN_URL', url: 42 }, O)).toBeNull()
  })
  it('never leaves the portal', () => {
    expect(portalUrlFromSwMessage({ type: 'PORTAL_OPEN_URL', url: 'https://evil.com/portal/chat' }, O)).toBeNull()
    expect(portalUrlFromSwMessage({ type: 'PORTAL_OPEN_URL', url: '//evil.com/portal' }, O)).toBeNull()
    expect(portalUrlFromSwMessage({ type: 'PORTAL_OPEN_URL', url: '/admin' }, O)).toBeNull()
    expect(portalUrlFromSwMessage({ type: 'PORTAL_OPEN_URL', url: '/portalx' }, O)).toBeNull()
    expect(portalUrlFromSwMessage({ type: 'PORTAL_OPEN_URL', url: 'javascript:alert(1)' }, O)).toBeNull()
  })
})
