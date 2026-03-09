import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  // Legacy rewrite: /?t=TOKEN → /offer/TOKEN (must happen before auth check)
  if (request.nextUrl.pathname === '/' && request.nextUrl.searchParams.has('t')) {
    const token = request.nextUrl.searchParams.get('t')
    const url = request.nextUrl.clone()
    url.pathname = `/offer/${token}`
    url.search = ''
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

  if (
    !user &&
    !request.nextUrl.pathname.startsWith('/login') &&
    !request.nextUrl.pathname.startsWith('/auth') &&
    !request.nextUrl.pathname.startsWith('/api/qb') &&
    !request.nextUrl.pathname.startsWith('/api/mcp') &&
    !request.nextUrl.pathname.startsWith('/api/sse') &&
    !request.nextUrl.pathname.startsWith('/api/message') &&
    !request.nextUrl.pathname.startsWith('/api/sync-drive') &&
    !request.nextUrl.pathname.startsWith('/api/sync-airtable') &&
    !request.nextUrl.pathname.startsWith('/offer') &&
    !request.nextUrl.pathname.startsWith('/contract-template') &&
    !request.nextUrl.pathname.startsWith('/.well-known') &&
    !request.nextUrl.pathname.startsWith('/oauth')
  ) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  if (user && request.nextUrl.pathname === '/login') {
    const url = request.nextUrl.clone()
    url.pathname = '/'
    return NextResponse.redirect(url)
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
