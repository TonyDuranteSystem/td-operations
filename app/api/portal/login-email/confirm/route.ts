import { NextRequest, NextResponse } from 'next/server'
import { isFailure } from '@/lib/portal/login-email-change'
import { refusal, requireClientLogin } from '@/lib/portal/login-email-change-http'
import { confirmLoginEmailChange } from '@/lib/portal/login-email-change-service'

export const dynamic = 'force-dynamic'

/**
 * POST /api/portal/login-email/confirm — step 2: the code is entered and the login moves.
 * Body: { requestId, code }. The client's open session keeps working (measured), so no new login is needed.
 */
export async function POST(request: NextRequest) {
  const gate = await requireClientLogin(request)
  if ('response' in gate) return gate.response
  const body = await request.json().catch(() => ({}))
  const result = await confirmLoginEmailChange({ identity: gate.identity, requestId: body.requestId, code: body.code })
  if (isFailure(result)) return refusal(result.code, { retryAfterSeconds: result.retryAfterSeconds, attemptsLeft: result.attemptsLeft })
  return NextResponse.json(result)
}
