import { NextRequest, NextResponse } from 'next/server'
import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { findAuthUsersByContactId } from '@/lib/auth-admin-helpers'
import { verifyViewAs, signViewAs, VIEW_AS_COOKIE, MARKER_TTL_MS } from '@/lib/portal/view-as'
import { PORTAL_BASE_URL } from '@/lib/config'

/**
 * GET /portal/view-as?t=<signed-token>  — Step 2 of read-only "View as client".
 *
 * Verifies the admin-minted authorization token, mints the TARGET CLIENT's
 * session SERVER-SIDE (magiclink token → verifyOtp, no email sent — proven in
 * sandbox), sets the session cookies on the PORTAL domain only, drops the signed
 * `td_view_as` marker cookie (drives the read-only middleware lock + the banner),
 * writes an audit row, and redirects into the portal.
 *
 * Must be listed in middleware PUBLIC_PREFIXES: at entry there is no portal
 * session yet, and the token itself is the gate.
 */
function fail(reason: string): NextResponse {
  const url = new URL('/portal/login', PORTAL_BASE_URL)
  url.searchParams.set('view_as_error', reason)
  return NextResponse.redirect(url)
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('t')
  const marker = await verifyViewAs(token)
  if (!marker) return fail('invalid_or_expired')

  // Resolve the target client's auth user from the contact id in the token.
  const authUsers = await findAuthUsersByContactId(marker.contactId)
  const clientUser = authUsers.find((u) => u.app_metadata?.role === 'client')
  if (!clientUser?.email) return fail('no_login')

  // Capture the client's real last-login BEFORE we mint a session. verifyOtp
  // below stamps last_sign_in_at = now(); we restore this value afterwards so an
  // admin's View-as never counts as the client logging in (which would hide the
  // "Resend Welcome" button + misreport "Last login"). Null = never logged in.
  const priorLastSignIn = clientUser.last_sign_in_at ?? null

  // Mint a one-time magiclink token for the client (does NOT send email).
  const { data: link, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email: clientUser.email,
  })
  const tokenHash = link?.properties?.hashed_token
  if (linkErr || !tokenHash) return fail('mint_failed')

  // Establish the client session into cookies set on THIS (portal) response.
  const response = NextResponse.redirect(new URL('/portal', PORTAL_BASE_URL))
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll()
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          )
        },
      },
    },
  )

  const { error: otpErr } = await supabase.auth.verifyOtp({ type: 'email', token_hash: tokenHash })
  if (otpErr) return fail('session_failed')

  // Restore the client's real last-login — verifyOtp just stamped it to now().
  // Best-effort: a failure here must not block the view. (See migration
  // 20260615-2100-viewas-restore-last-sign-in.sql.)
  try {
    // The fn is added by migration 20260615-2100 and isn't in the generated
    // Supabase types — type the call inline so one new fn doesn't need a full
    // types regen.
    const restore = supabaseAdmin.rpc as unknown as (
      fn: string,
      args: { p_user_id: string; p_ts: string | null },
    ) => Promise<{ error: { message: string } | null }>
    await restore('viewas_restore_last_sign_in', {
      p_user_id: clientUser.id,
      p_ts: priorLastSignIn,
    })
  } catch (e) {
    console.error('[view-as] failed to restore last_sign_in_at:', e)
  }

  // Drop the read-only marker cookie (signed, httpOnly, portal domain).
  const markerToken = await signViewAs(
    { contactId: marker.contactId, adminId: marker.adminId },
    MARKER_TTL_MS,
  )
  response.cookies.set(VIEW_AS_COOKIE, markerToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(MARKER_TTL_MS / 1000),
  })

  // Audit — never let a logging failure block the view.
  try {
    await supabaseAdmin.from('action_log').insert({
      actor: `admin:${marker.adminId}`,
      action_type: 'portal_view_as_enter',
      table_name: 'contacts',
      record_id: marker.contactId,
      contact_id: marker.contactId,
      summary: `Admin opened read-only portal view as contact ${marker.contactId}`,
      details: { admin_id: marker.adminId, client_email: clientUser.email },
    })
  } catch (e) {
    console.error('[view-as] audit log (enter) failed:', e)
  }

  return response
}
