import { NextRequest, NextResponse } from 'next/server'
import { createServerClient, type CookieOptions } from '@supabase/ssr'

/**
 * GET /portal/auth/callback
 *
 * Handles Supabase PKCE auth callbacks (password reset, magic links).
 * Exchanges the `code` query param for a session SERVER-SIDE, then redirects.
 *
 * This is critical for mobile: email links may open in a different browser
 * context where the client-side code_verifier cookie is missing. By exchanging
 * the code server-side, we set the session cookies directly in the response.
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

    const { error } = await supabase.auth.exchangeCodeForSession(code)

    if (error) {
      // Code exchange failed — redirect to forgot-password with error
      console.error('[auth/callback] Code exchange failed:', error.message)
      const errorUrl = request.nextUrl.clone()
      errorUrl.pathname = '/portal/forgot-password'
      errorUrl.searchParams.set('error', 'expired')
      errorUrl.searchParams.delete('code')
      errorUrl.searchParams.delete('next')
      return NextResponse.redirect(errorUrl)
    }

    return response
  }

  // No code — just redirect
  return NextResponse.redirect(redirectUrl)
}
