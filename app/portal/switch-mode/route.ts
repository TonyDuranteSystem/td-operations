import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /portal/switch-mode?mode=client|partner
 *
 * For a dual-role person (client AND partner), set the `portal_mode` cookie and
 * land them in the right home. The portal layout reads this cookie to pick which
 * view (and nav) to render. Single-role users never see the switcher, so this is
 * a no-op for them (the layout falls back to their one capability).
 */
export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get('mode') === 'partner' ? 'partner' : 'client'
  const dest = mode === 'partner' ? '/portal/partner/clients' : '/portal'
  const res = NextResponse.redirect(new URL(dest, req.nextUrl.origin))
  res.cookies.set('portal_mode', mode, {
    path: '/',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365,
  })
  return res
}
