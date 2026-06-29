import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyViewAs, VIEW_AS_COOKIE } from '@/lib/portal/view-as'

// --- Public paths (no auth required) ---
const PUBLIC_PREFIXES = [
  // Auth pages
  '/login',
  '/auth',
  '/portal/login',
  '/portal/forgot-password',
  '/portal/reset-password',
  '/portal/auth/callback',
  // Admin read-only "View as client" entry/exit — token-gated, tears down/sets
  // its own session, so must run without an existing portal session.
  '/portal/view-as',
  // API: external webhooks, cron, sync, dashboard badges
  '/api/dashboard/badges',
  '/api/qb',
  '/api/mcp',
  '/api/sse',
  '/api/message',
  '/api/sync-drive',
  '/api/sync-airtable',
  '/api/webhooks',
  '/api/cron',
  // Liveness probe for post-deploy smoke (P2.7 — plan §4 line 576).
  // No auth: anything that gates liveness behind auth is not a liveness probe.
  '/api/health',
  // TEMPORARY debug endpoint — requires API_SECRET_TOKEN, will be removed
  '/api/admin/audit-debug',
  '/api/workflows',
  '/api/jobs',
  '/api/track',
  '/api/tax-quote-completed',
  '/api/tax-form-completed',
  '/api/formation-form-completed',
  '/api/banking-form-completed',
  '/api/itin-form-completed',
  '/api/lease-signed',
  '/api/oa-signed',
  '/api/ss4-signed',
  '/api/ss4',
  // Referral landing page (/invitation/[code]) + legacy /r/ redirect
  '/r/',
  '/invitation/',
  // Referral click counter — anonymous landing visitors POST here to log a click
  '/api/referral/track',
  // Client-facing forms (email-gated, no Supabase auth)
  '/offer',
  '/tax-form',
  '/formation-form',
  '/onboarding-form',
  '/banking-form',
  '/lease',
  '/operating-agreement',
  '/closure-form',
  '/itin-form',
  '/tax-quote',
  '/contract-template',
  '/ss4',
  '/sign-document',
  // Generic e-sign signer page + API (per-signer token + access code; no Supabase auth)
  '/sign/',
  '/api/sign/',
  // pdfjs worker (public static asset the signer/editor fetch in the browser)
  '/esign/pdf.worker.min.mjs',
  // Legacy MMLLC member info collection form (token+code URL auth)
  '/member-info',
  '/api/member-info',
  // Contact request form — token+code URL auth (admin sends to client via portal chat)
  '/contact-request',
  '/api/contact-request',
  // Portal welcome link — token-keyed credential page sent after offer publish
  '/welcome',
  // Portal announcements — public read for the client portal banner
  '/api/portal/announcements',
  // Stable pay redirect — /pay/<opaque-token> regenerates a Stripe session
  // and 302s the client to the checkout URL. Token-gated, no Supabase auth.
  '/pay',
  '/api/signature-request',
  '/api/signature-request-signed',
  '/api/offers',
  // OAuth and well-known
  '/.well-known',
  '/oauth',
  // PWA manifests — must be public for Chrome installability
  '/manifest.webmanifest',
  '/portal/manifest.webmanifest',
]

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(prefix => pathname.startsWith(prefix))
}

function isPortalPath(pathname: string): boolean {
  // Match ONLY the client portal route group — `/portal` and `/portal/...`.
  // Must NOT match staff dashboard pages that merely share the prefix
  // (`/portal-chats`, `/portal-launch`), or clients would not be redirected
  // away from them. See sysdoc notification-center-workflow-integration-plan.
  return pathname === '/portal' || pathname.startsWith('/portal/')
}

function isDashboardPath(pathname: string): boolean {
  // Dashboard pages are everything under (dashboard) route group
  // which includes /, /tasks, /accounts, /inbox, etc.
  // But NOT /portal, /offer, /login, /api, etc.
  return !isPortalPath(pathname) && !pathname.startsWith('/api') && !pathname.startsWith('/login')
}

export async function middleware(request: NextRequest) {
  // Startup guards: fail fast with a clear 500 rather than a cryptic
  // MIDDLEWARE_INVOCATION_FAILED when Supabase env vars are missing.
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    return new NextResponse('FATAL: NEXT_PUBLIC_SUPABASE_URL is not configured', { status: 500 })
  }
  if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return new NextResponse('FATAL: NEXT_PUBLIC_SUPABASE_ANON_KEY is not configured', { status: 500 })
  }

  // Sandbox guard: block inbound webhooks to prevent external traffic from
  // mutating sandbox data when SANDBOX_MODE=1
  if (process.env.SANDBOX_MODE === '1' && request.nextUrl.pathname.startsWith('/api/webhooks')) {
    return new NextResponse('Service Unavailable (sandbox mode)', { status: 503 })
  }

  // Legacy rewrite: /?t=TOKEN → /offer/TOKEN (must happen before auth check)
  if (request.nextUrl.pathname === '/' && request.nextUrl.searchParams.has('t')) {
    const token = request.nextUrl.searchParams.get('t')
    const code = request.nextUrl.searchParams.get('c')
    const url = request.nextUrl.clone()
    url.pathname = `/offer/${token}`
    url.search = code ? `c=${code}` : ''
    return NextResponse.rewrite(url)
  }

  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()
  const pathname = request.nextUrl.pathname

  // --- Public paths: no auth required ---
  if (isPublicPath(pathname)) {
    return supabaseResponse
  }

  // --- Read-only "View as client" lock ---
  // While a valid view-as marker is present, allow only safe reads (GET/HEAD)
  // on portal surfaces and BLOCK every mutating request — API writes AND server
  // actions (which POST to the page route). This is the single guard that makes
  // the admin's client view read-only. The entry/exit routes are public above,
  // so they are exempt. Forging/deleting the marker is not an escalation (see
  // lib/portal/view-as.ts security note).
  if (
    (pathname.startsWith('/portal') || pathname.startsWith('/api/portal')) &&
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)
  ) {
    const marker = request.cookies.get(VIEW_AS_COOKIE)?.value
    if (marker && (await verifyViewAs(marker))) {
      return new NextResponse(
        JSON.stringify({
          error: 'Read-only view — actions are disabled while viewing as a client. Click Exit to leave.',
        }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      )
    }
  }

  // --- No user: redirect to appropriate login ---
  if (!user) {
    const url = request.nextUrl.clone()
    if (isPortalPath(pathname)) {
      url.pathname = '/portal/login'
    } else {
      url.pathname = '/login'
    }
    return NextResponse.redirect(url)
  }

  // --- Suspended login (admin ban): block immediately ---
  // A login suspended from the dashboard is banned at the auth layer. getUser()
  // (already called above) returns banned_until reliably even on a still-valid
  // access token, so this bounces a suspended client on their very NEXT request
  // instead of waiting for their token to expire. Clear the stale Supabase
  // session cookies and send them to login with the suspension notice. No loop:
  // /portal/login is a public path and returns earlier, so the login page itself
  // is reachable. No added cost: the getUser() call already happens for auth.
  const bannedUntil = (user as { banned_until?: string | null }).banned_until ?? null
  if (bannedUntil && new Date(bannedUntil) > new Date()) {
    const url = request.nextUrl.clone()
    url.pathname = '/portal/login'
    url.search = 'reason=suspended'
    const res = NextResponse.redirect(url)
    for (const c of request.cookies.getAll()) {
      if (c.name.startsWith('sb-')) res.cookies.delete(c.name)
    }
    return res
  }

  const role = user.app_metadata?.role

  // --- Partner confinement (external collaborators, e.g. Cris) ---
  // A partner authenticates as role='partner' (NOT 'client'), so without this
  // branch they would pass the dashboard guard below and reach the entire CRM.
  // Confine them strictly to their collaboration surface: the /collab page, the
  // /api/conversations endpoints, and the /api/td-communication project-pipeline
  // endpoints (Phase 2). Everything else bounces to /collab.
  if (role === 'partner') {
    const partnerAllowed =
      pathname === '/collab' ||
      pathname.startsWith('/collab/') ||
      pathname.startsWith('/api/conversations') ||
      pathname.startsWith('/api/td-communication')
    if (!partnerAllowed) {
      const url = request.nextUrl.clone()
      url.pathname = '/collab'
      url.search = ''
      return NextResponse.redirect(url)
    }
    return supabaseResponse
  }

  // --- Portal paths: require client role ---
  if (isPortalPath(pathname)) {
    if (role !== 'client') {
      // Admin accessing portal — allow for debugging (they can see client view)
      // If you want to block admins from portal, uncomment:
      // const url = request.nextUrl.clone()
      // url.pathname = '/'
      // return NextResponse.redirect(url)
    }
    return supabaseResponse
  }

  // --- Dashboard paths: require admin (non-client) ---
  if (isDashboardPath(pathname)) {
    if (role === 'client') {
      // Client trying to access admin dashboard — redirect to portal
      const url = request.nextUrl.clone()
      url.pathname = '/portal'
      return NextResponse.redirect(url)
    }

    // Admin-only paths: team users redirected to home
    const ADMIN_ONLY_PATHS = ['/dev-tools', '/team-management']
    const isAdminEmail = user.email && ['antonio.durante@tonydurante.us'].includes(user.email)
    const isAdminRole = user.app_metadata?.role === 'admin' || user.user_metadata?.role === 'admin'
    if (ADMIN_ONLY_PATHS.some(p => pathname === p || pathname.startsWith(p + '/')) && !isAdminEmail && !isAdminRole) {
      const url = request.nextUrl.clone()
      url.pathname = '/'
      url.searchParams.set('denied', 'admin_only')
      return NextResponse.redirect(url)
    }
  }

  // --- Logged-in user on /login: redirect to home ---
  if (pathname === '/login') {
    const url = request.nextUrl.clone()
    url.pathname = role === 'client' ? '/portal' : '/'
    return NextResponse.redirect(url)
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    // Exclude static asset directories and common binary/font extensions so the
    // middleware doesn't try to auth-gate public files. The `fonts/` prefix and
    // the `ttf|otf|woff|woff2` extensions were added so that PDF generators can
    // fetch DejaVu Sans from public/fonts/* at runtime (see lib/pdf/unicode-fonts.ts
    // and dev_task 208d20be). `templates/` is excluded for the same reason for
    // ss4-blank.pdf / 8832-blank.pdf.
    '/((?!_next/static|_next/image|favicon.ico|templates/|fonts/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|pdf|webmanifest|ttf|otf|woff|woff2)$).*)',
  ],
}
