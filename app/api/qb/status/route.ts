/**
 * GET /api/qb/status
 *
 * Returns the current QuickBooks connection status.
 * Shows token health, expiry times, and whether re-auth is needed.
 *
 * Useful for dashboard health checks and monitoring.
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getActiveToken } from '@/lib/quickbooks'

export async function GET() {
  try {
    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Try to get (and auto-refresh if needed) the active token
    let refreshedNow = false
    try {
      await getActiveToken()
      refreshedNow = true
    } catch {
      // Token refresh failed — continue to report stored status
    }

    // Get current active token from Supabase
    const { data: token, error } = await supabaseAdmin
      .from('qb_tokens')
      .select('realm_id, access_token_expires_at, refresh_token_expires_at, updated_at, is_active')
      .eq('realm_id', process.env.QB_REALM_ID!)
      .eq('is_active', true)
      .single()

    if (error || !token) {
      return NextResponse.json({
        connected: false,
        status: 'NOT_CONNECTED',
        message: 'No active QuickBooks connection. Visit /api/qb/authorize to connect.',
        authorize_url: '/api/qb/authorize',
      })
    }

    const now = new Date()
    const accessExpiresAt = new Date(token.access_token_expires_at)
    const refreshExpiresAt = new Date(token.refresh_token_expires_at)

    const accessValid = now < accessExpiresAt
    const refreshValid = now < refreshExpiresAt

    // Calculate time remaining
    const accessMinutesLeft = Math.round((accessExpiresAt.getTime() - now.getTime()) / 60000)
    const refreshDaysLeft = Math.round((refreshExpiresAt.getTime() - now.getTime()) / 86400000)

    let status: string
    if (!refreshValid) {
      status = 'EXPIRED'
    } else if (!accessValid) {
      status = 'ACCESS_EXPIRED_WILL_REFRESH'
    } else if (refreshDaysLeft < 14) {
      status = 'REFRESH_EXPIRING_SOON'
    } else {
      status = 'HEALTHY'
    }

    // Check critical env vars (presence only, not values)
    const envCheck = {
      NEXT_PUBLIC_SUPABASE_URL: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      QB_CLIENT_ID: !!process.env.QB_CLIENT_ID,
      QB_CLIENT_SECRET: !!process.env.QB_CLIENT_SECRET,
      QB_REALM_ID: !!process.env.QB_REALM_ID,
      QB_REDIRECT_URI: !!process.env.QB_REDIRECT_URI,
    }
    const envMissing = Object.entries(envCheck)
      .filter(([, v]) => !v)
      .map(([k]) => k)

    const response = NextResponse.json({
      connected: refreshValid,
      status,
      realm_id: token.realm_id,
      access_token: {
        valid: accessValid,
        expires_at: accessExpiresAt.toISOString(),
        minutes_remaining: accessValid ? accessMinutesLeft : 0,
      },
      refresh_token: {
        valid: refreshValid,
        expires_at: refreshExpiresAt.toISOString(),
        days_remaining: refreshValid ? refreshDaysLeft : 0,
      },
      last_updated: token.updated_at,
      env: {
        all_set: envMissing.length === 0,
        missing: envMissing.length > 0 ? envMissing : undefined,
      },
      ...((!refreshValid) && {
        action_required: 'Re-authorize at /api/qb/authorize',
        authorize_url: '/api/qb/authorize',
      }),
      ...(refreshDaysLeft < 14 && refreshValid && {
        warning: `Refresh token expires in ${refreshDaysLeft} days. Consider re-authorizing soon.`,
      }),
    })

    // Prevent browser caching — always return fresh token status
    response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate')
    response.headers.set('Pragma', 'no-cache')

    return response

  } catch (err) {
    console.error('[QB Status] Error:', err)
    return NextResponse.json(
      { connected: false, status: 'ERROR', error: String(err) },
      { status: 500 }
    )
  }
}
