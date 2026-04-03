import { NextRequest, NextResponse } from 'next/server'
import { createServerClient, type CookieOptions } from '@supabase/ssr'

/**
 * GET /portal/auth/callback
 *
 * Handles Supabase PKCE auth callbacks (password reset, magic links).
 * Exchanges the `code` query param for a session, then redirects to `next`.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const code = searchParams.get('code')
  const next = searchParams.get('next') || '/portal'

  const redirectUrl = request.nextUrl.clone()
  redirectUrl.pathname = next
  redirectUrl.searchParams.delete('code')
  redirectUrl.searchParams.delete('next')

  if (code) {
    const response = NextResponse.redirect(redirectUrl)

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll()
          },
          setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
            cookiesToSet.forEach(({ name, value, options }) =>
              response.cookies.set(name, value, options)
            )
          },
        },
      }
    )

    await supabase.auth.exchangeCodeForSession(code)
    return response
  }

  // No code — just redirect
  return NextResponse.redirect(redirectUrl)
}
