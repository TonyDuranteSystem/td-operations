import { NextRequest, NextResponse } from 'next/server'
import { isFailure } from '@/lib/portal/login-email-change'
import { refusal, requireClientLogin } from '@/lib/portal/login-email-change-http'
import { resendLoginEmailCode } from '@/lib/portal/login-email-change-service'

export const dynamic = 'force-dynamic'

/** POST /api/portal/login-email/resend — a new code for the open request (one per minute, five in all). Body: { requestId }. */
export async function POST(request: NextRequest) {
  const gate = await requireClientLogin(request)
  if ('response' in gate) return gate.response
  const body = await request.json().catch(() => ({}))
  const result = await resendLoginEmailCode({ identity: gate.identity, requestId: body.requestId })
  if (isFailure(result)) return refusal(result.code, { retryAfterSeconds: result.retryAfterSeconds })
  return NextResponse.json(result)
}
