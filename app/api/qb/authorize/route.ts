/**
 * GET /api/qb/authorize
 *
 * Starts the QuickBooks OAuth2 authorization flow.
 * Redirects the user to Intuit's consent page.
 * After granting access, Intuit redirects back to /api/qb/callback.
 *
 * Usage: Navigate to https://td-operations.vercel.app/api/qb/authorize
 */

import { NextResponse } from 'next/server'
import { getAuthorizationUrl } from '@/lib/quickbooks'

export async function GET() {
  try {
    // Generate a random state parameter for CSRF protection
    const state = crypto.randomUUID()

    const authUrl = getAuthorizationUrl(state)

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
