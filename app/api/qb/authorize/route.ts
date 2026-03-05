/**
 * GET /api/qb/authorize
 *
 * Starts the QuickBooks OAuth2 authorization flow.
 * Redirects the user to Intuit's consent page.
 * After granting access, Intuit redirects back to /api/qb/callback.
 *
 * Usage: Navigate to https://td-operations.vercel.app/api/qb/authorize
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthorizationUrl } from '@/lib/quickbooks'

export async function GET(request: NextRequest) {
  // Debug mode: ?debug=1 shows the URL instead of redirecting
  const debug = request.nextUrl.searchParams.get('debug')

  try {
    // Generate a random state parameter for CSRF protection
    const state = crypto.randomUUID()

    const authUrl = getAuthorizationUrl(state)

    if (debug) {
      return NextResponse.json({
        auth_url: authUrl,
        client_id_prefix: process.env.QB_CLIENT_ID?.substring(0, 12) + '...',
        redirect_uri: process.env.QB_REDIRECT_URI,
      })
    }

    // Redirect user to Intuit's OAuth consent page
    return NextResponse.redirect(authUrl)
  } catch (error) {
    console.error('[QB Auth] Error generating authorization URL:', error)
    return NextResponse.json(
      { error: 'Failed to start QuickBooks authorization' },
      { status: 500 }
    )
  }
}
