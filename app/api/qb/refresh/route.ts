// GET /api/qb/refresh  (Vercel Cron — every 6 hours)
// POST /api/qb/refresh (Manual trigger)
//
// Proactively refreshes the QB access token before it expires.
// Each refresh also renews the 101-day refresh token window.
//
// Auth (any of):
//   - Authorization: Bearer <CRON_SECRET>          (Vercel Cron)
//   - Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY> (manual/server)
//   - Authorization: Bearer <TD_MCP_API_KEY>       (MCP server calls)
//
// Vercel Cron config: vercel.json → "0 */6 * * *" (every 6 hours)

export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { refreshAccessToken, storeTokens } from '@/lib/quickbooks'
import { logCron } from '@/lib/cron-log'

function isAuthorized(request: NextRequest): boolean {
  const authHeader = request.headers.get('authorization')
  if (!authHeader) return false

  const token = authHeader.replace('Bearer ', '')

  // Check against all valid secrets
  const validSecrets = [
    process.env.CRON_SECRET,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.TD_MCP_API_KEY,
  ].filter(Boolean)

  return validSecrets.includes(token)
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
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
      console.error('[QB Cron] No active token found')
      return NextResponse.json(
        { error: 'No active token found. Re-authorize at /api/qb/authorize' },
        { status: 404 }
      )
    }

    // Check if refresh token itself is still valid
    const now = new Date()
    const refreshExpiresAt = new Date(token.refresh_token_expires_at)
    if (now >= refreshExpiresAt) {
      console.error('[QB Cron] Refresh token EXPIRED — manual re-auth required')
      return NextResponse.json(
        { error: 'Refresh token expired. Re-authorize at /api/qb/authorize' },
        { status: 401 }
      )
    }

    // Calculate days until refresh token expires
    const daysRemaining = Math.floor((refreshExpiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))

    // Refresh the token
    console.log(`[QB Cron] Refreshing access token... (refresh token: ${daysRemaining} days remaining)`)
    const newTokenData = await refreshAccessToken(token.refresh_token)
    await storeTokens(newTokenData, token.created_by)

    // Calculate when the new tokens expire
    const newAccessExpires = new Date(now.getTime() + newTokenData.expires_in * 1000)
    const newRefreshExpires = new Date(now.getTime() + newTokenData.x_refresh_token_expires_in * 1000)
    const newDaysRemaining = Math.floor((newRefreshExpires.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))

    console.log(`[QB Cron] ✅ Token refreshed. Access expires: ${newAccessExpires.toISOString()}, Refresh: ${newDaysRemaining} days`)

    const elapsed = Date.now() - now.getTime()
    logCron({ endpoint: '/api/qb/refresh', status: 'success', duration_ms: elapsed, details: { refresh_token_days_remaining: newDaysRemaining } })

    return NextResponse.json({
      success: true,
      message: 'Token refreshed successfully',
      access_token_expires_at: newAccessExpires.toISOString(),
      refresh_token_expires_at: newRefreshExpires.toISOString(),
      refresh_token_days_remaining: newDaysRemaining,
    })

  } catch (err) {
    console.error('[QB Cron] Error:', err)
    logCron({ endpoint: '/api/qb/refresh', status: 'error', duration_ms: 0, error_message: String(err) })
    return NextResponse.json(
      { error: 'Token refresh failed', details: String(err) },
      { status: 500 }
    )
  }
}

// POST handler — same logic
export async function POST(request: NextRequest) {
  return GET(request)
}
