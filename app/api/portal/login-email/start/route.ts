import { NextRequest, NextResponse } from 'next/server'
import { isFailure } from '@/lib/portal/login-email-change'
import { refusal, requireClientLogin } from '@/lib/portal/login-email-change-http'
import { startLoginEmailChange } from '@/lib/portal/login-email-change-service'

export const dynamic = 'force-dynamic'

/**
 * POST /api/portal/login-email/start — step 1 of "change my login email" (dev job beb43385).
 * Body: { newEmail, password }. The caller is always the logged-in client (from the session, never from the body).
 * Checks the password, then sends a 6-digit code to the NEW address. Nothing changes until the code is entered.
 * Lives under /api/portal/, so the View-as read-only lock covers it.
 */
export async function POST(request: NextRequest) {
  const gate = await requireClientLogin(request)
  if ('response' in gate) return gate.response
  const body = await request.json().catch(() => ({}))
  const result = await startLoginEmailChange({ identity: gate.identity, newEmail: body.newEmail, password: body.password })
  if (isFailure(result)) return refusal(result.code, { retryAfterSeconds: result.retryAfterSeconds })
  return NextResponse.json(result)
}
