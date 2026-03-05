// POST /api/qb/refresh
//
// Manually triggers a token refresh.
// Can also be called by a cron job (Vercel Cron or external).
//
// The getActiveToken() helper auto-refreshes when needed,
// but this endpoint allows proactive refresh before expiry.
//
// Headers:
//   Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY> (for cron/server calls)
//
// Vercel Cron config (add to vercel.json):
//   { "crons": [{ "path": "/api/qb/refresh", "schedule": "0 0,12 * * *" }] }

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { refreshAccessToken, storeTokens } from '@/lib/quickbooks'

export async function POST(request: NextRequest) {
  // Verify authorization (service role key or cron secret)
  const authHeader = request.headers.get('authorization')
  const cronSecret = request.headers.get('x-vercel-cron-secret')

  // Allow Vercel cron jobs (they don't send auth headers but come from Vercel infra)
  // For manual calls, verify the service role key
  if (!cronSecret && authHeader !== `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`) {
    // Also check if it's a Vercel cron call (has specific user-agent)
    const userAgent = request.headers.get('user-agent') || ''
    if (!userAgent.includes('vercel-cron')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  try {
    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Get current active token
    const { data: token, error } = await supabaseAdmin
      .from('qb_tokens')
      .select('*')
      .eq('realm_id', process.env.QB_REALM_ID!)
      .eq('is_active', true)
      .single()

    if (error || !token) {
      return NextResponse.json(
        { error: 'No active token found. Re-authorize at /api/qb/authorize' },
        { status: 404 }
      )
    }

    // Check if refresh token itself is still valid
    const now = new Date()
    const refreshExpiresAt = new Date(token.refresh_token_expires_at)
    if (now >= refreshExpiresAt) {
      return NextResponse.json(
        { error: 'Refresh token expired. Re-authorize at /api/qb/authorize' },
        { status: 401 }
      )
    }

    // Refresh the token
    console.log('[QB Refresh] Refreshing access token...')
    const newTokenData = await refreshAccessToken(token.refresh_token)
    await storeTokens(newTokenData, token.created_by)

    // Calculate when the new tokens expire
    const newAccessExpires = new Date(now.getTime() + newTokenData.expires_in * 1000)
    const newRefreshExpires = new Date(now.getTime() + newTokenData.x_refresh_token_expires_in * 1000)

    console.log('[QB Refresh] Token refreshed successfully')

    return NextResponse.json({
      success: true,
      message: 'Token refreshed successfully',
      access_token_expires_at: newAccessExpires.toISOString(),
      refresh_token_expires_at: newRefreshExpires.toISOString(),
    })

  } catch (err) {
    console.error('[QB Refresh] Error:', err)
    return NextResponse.json(
      { error: 'Token refresh failed', details: String(err) },
      { status: 500 }
    )
  }
}

// Also support GET for Vercel Cron (crons use GET by default)
export async function GET(request: NextRequest) {
  return POST(request)
}
