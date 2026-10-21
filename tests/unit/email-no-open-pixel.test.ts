import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { OPEN_PIXEL_ENABLED, openPixelImg } from '@/lib/email/open-pixel'

// Tony Durante's OWN emails carry no open-tracking picture (Garante consent rule, dev job e5d5400d / 1a23f5f1).
describe('open pixel is switched off', () => {
  it('the helper returns nothing while switched off', () => {
    expect(OPEN_PIXEL_ENABLED).toBe(false)
    expect(openPixelImg('https://app.tonydurante.us/api/track/open/et_1')).toBe('')
    expect(openPixelImg(null)).toBe('')
  })

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p, out)
      else if (/\.(ts|tsx)$/.test(name)) out.push(p)
    }
    return out
  }

  it('no source file builds a 1x1 invisible image outside the helper', () => {
    const offenders: string[] = []
    for (const root of ['app', 'lib', 'components']) {
      for (const f of walk(root)) {
        if (f === 'lib/email/open-pixel.ts') continue
        const s = readFileSync(f, 'utf8')
        if (/width="1"\s+height="1"/.test(s) && /display:\s*none/.test(s)) offenders.push(f)
      }
    }
    expect(offenders).toEqual([])
  })

  it('every email sender goes through the helper', () => {
    for (const f of ['lib/offers/publish.ts', 'lib/esign/send.ts', 'lib/mcp/tools/lease.ts', 'lib/mcp/tools/oa.ts', 'lib/mcp/tools/portal.ts', 'lib/mcp/tools/offers.ts', 'app/api/crm/admin-actions/resend-offer/route.ts', 'lib/operations/email.ts']) {
      expect(readFileSync(f, 'utf8'), f).toContain('openPixelImg(')
    }
  })

  it('the email_tracking record of each send is KEPT (delivery status, duplicate guard, lead timeline depend on it)', () => {
    expect(readFileSync('lib/jobs/handlers/esign-send-email.ts', 'utf8')).toContain('email_tracking')
    expect(readFileSync('lib/operations/email.ts', 'utf8')).toContain('email_tracking')
    expect(readFileSync('lib/esign/send.ts', 'utf8')).toContain('inviteTrackingPixelUrl')
  })

  it('the open route stays for emails already in inboxes', () => {
    expect(readFileSync('app/api/track/open/[id]/route.ts', 'utf8').length).toBeGreaterThan(0)
  })

  it('the staff compose screen no longer offers a Track toggle', () => {
    const s = readFileSync('components/inbox/compose-dialog.tsx', 'utf8')
    expect(s).not.toContain('Open tracking')
    expect(s).not.toContain('track_opens')
  })
})

import { buildSignerInviteEmail } from '@/lib/esign/send'
import { buildPortalNotificationEmail } from '@/lib/offers/publish'

describe('real builders: executed, not just read', () => {
  it('e-sign invite has no invisible image even when a pixel URL is passed', () => {
    const { raw } = buildSignerInviteEmail({
      to: 'a@example.com', signerName: 'Mario', documentName: 'Doc', signUrl: 'https://app.example.com/sign/t/c',
      requesterName: 'Tony Durante LLC', language: 'it', trackingPixelUrl: 'https://app.example.com/api/track/open/et_1',
    })
    const html = Buffer.from(raw.split(/\r?\n\r?\n/).slice(1).join('\n\n'), 'base64').toString('utf8') || raw
    expect(raw).not.toContain('/api/track/open/')
    expect(html).not.toMatch(/<img[^>]*(width="1"|track\/open)/)
    expect(raw).toContain('/sign/t/c') // the signing link itself is still there
  })
  it('offer portal notification has no invisible image and keeps its button', () => {
    const html = buildPortalNotificationEmail('Mario', { title: 'T', body: 'B', ctaLabel: 'View Offer', ctaUrl: 'https://app.example.com/offer/x' }, 'en', 'https://app.example.com/api/track/open/et_2')
    expect(html).not.toContain('/api/track/open/')
    expect(html).not.toMatch(/<img[^>]*width="1"/)
    expect(html).toContain('View Offer')
    expect(html).toContain('https://app.example.com/offer/x')
  })
})
