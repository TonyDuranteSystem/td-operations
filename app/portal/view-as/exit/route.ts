import { NextRequest, NextResponse } from 'next/server'
import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { verifyViewAs, VIEW_AS_COOKIE } from '@/lib/portal/view-as'
import { PORTAL_BASE_URL } from '@/lib/config'

/**
 * GET /portal/view-as/exit — ends a read-only "View as client" session.
 *
 * Signs the minted client session out (clears the Supabase auth cookies on the
 * portal domain), removes the `td_view_as` marker, and audits the exit. The
 * admin's CRM session lives on a different domain and is untouched. Public path
 * (the session is being torn down); GET so the banner link works directly.
 */
export async function GET(req: NextRequest) {
  const markerCookie = req.cookies.get(VIEW_AS_COOKIE)?.value
  const marker = await verifyViewAs(markerCookie)

  const dest = new URL('/portal/login', PORTAL_BASE_URL)
  dest.searchParams.set('view_as', 'exited')
  const response = NextResponse.redirect(dest)

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

  try {
    // LOCAL scope: revoke ONLY this view-as session's token, never the real
    // client's other sessions. A global sign-out here would log the actual
    // client out of their own portal on every device — see view-as bugfix.
    await supabase.auth.signOut({ scope: 'local' })
  } catch (e) {
    console.error('[view-as] signOut on exit failed:', e)
  }

  // Belt-and-suspenders: explicitly clear the marker.
  response.cookies.set(VIEW_AS_COOKIE, '', { path: '/', maxAge: 0 })

  if (marker) {
    try {
      await supabaseAdmin.from('action_log').insert({
        actor: `admin:${marker.adminId}`,
        action_type: 'portal_view_as_exit',
        table_name: 'contacts',
        record_id: marker.contactId,
        contact_id: marker.contactId,
        summary: `Admin exited read-only portal view as contact ${marker.contactId}`,
        details: { admin_id: marker.adminId },
      })
    } catch (e) {
      console.error('[view-as] audit log (exit) failed:', e)
    }
  }

  return response
}
