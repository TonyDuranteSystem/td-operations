/**
 * GET /api/qb/callback
 *
 * Receives the authorization code from Intuit after user grants access.
 * Exchanges the code for access + refresh tokens.
 * Stores tokens securely in Supabase qb_tokens table.
 * Redirects to dashboard with success/error message.
 */

import { NextRequest, NextResponse } from 'next/server'
import { exchangeCodeForTokens, storeTokens } from '@/lib/quickbooks'

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const code = searchParams.get('code')
  const realmId = searchParams.get('realmId')
  const error = searchParams.get('error')

  // Handle user denial or errors
  if (error) {
    console.error('[QB Callback] Authorization denied:', error)
    const dashboardUrl = new URL('/', request.url)
    dashboardUrl.searchParams.set('qb_error', 'Authorization denied by user')
    return NextResponse.redirect(dashboardUrl)
  }

  // Validate required parameters
  if (!code) {
    console.error('[QB Callback] Missing authorization code')
    const dashboardUrl = new URL('/', request.url)
    dashboardUrl.searchParams.set('qb_error', 'Missing authorization code')
    return NextResponse.redirect(dashboardUrl)
  }

  // Log the realm ID received (should match our configured one)
  if (realmId && realmId !== process.env.QB_REALM_ID) {
    console.warn(`[QB Callback] Realm ID mismatch: received ${realmId}, expected ${process.env.QB_REALM_ID}`)
  }

  try {
    // Exchange authorization code for tokens
    console.log('[QB Callback] Exchanging code for tokens...')
    const tokenData = await exchangeCodeForTokens(code)

    console.log('[QB Callback] Token received. Access expires in:', tokenData.expires_in, 'seconds')
    console.log('[QB Callback] Refresh expires in:', tokenData.x_refresh_token_expires_in, 'seconds')

    // Store tokens in Supabase
    await storeTokens(tokenData)
    console.log('[QB Callback] Tokens stored successfully in Supabase')

    // Redirect to dashboard with success
    const dashboardUrl = new URL('/', request.url)
    dashboardUrl.searchParams.set('qb_connected', 'true')
    return NextResponse.redirect(dashboardUrl)

  } catch (err) {
    console.error('[QB Callback] Token exchange error:', err)
    const dashboardUrl = new URL('/', request.url)
    dashboardUrl.searchParams.set('qb_error', 'Token exchange failed')
    return NextResponse.redirect(dashboardUrl)
  }
}
