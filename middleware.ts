import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// --- Public paths (no auth required) ---
const PUBLIC_PREFIXES = [
  // Auth pages
  '/login',
  '/auth',
  '/portal/login',
  '/portal/forgot-password',
  '/portal/reset-password',
  // API: external webhooks, cron, sync
  '/api/qb',
  '/api/mcp',
  '/api/sse',
  '/api/message',
  '/api/sync-drive',
  '/api/sync-airtable',
  '/api/sync-hubspot',
  '/api/webhooks',
  '/api/cron',
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
  // OAuth and well-known
  '/.well-known',
  '/oauth',
]

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(prefix => pathname.startsWith(prefix))
}

function isPortalPath(pathname: string): boolean {
  return pathname.startsWith('/portal')
}

function isDashboardPath(pathname: string): boolean {
  // Dashboard pages are everything under (dashboard) route group
  // which includes /, /tasks, /accounts, /inbox, etc.
  // But NOT /portal, /offer, /login, /api, etc.
  return !isPortalPath(pathname) && !pathname.startsWith('/api') && !pathname.startsWith('/login')
}

export async function middleware(request: NextRequest) {
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

  const role = user.app_metadata?.role

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
    const ADMIN_ONLY_PATHS = ['/invoice-settings', '/reconciliation', '/portal-launch', '/audit', '/team-management']
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
    '/((?!_next/static|_next/image|favicon.ico|templates/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|pdf)$).*)',
  ],
}
