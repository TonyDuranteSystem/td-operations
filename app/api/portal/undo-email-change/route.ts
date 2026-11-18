import { NextRequest, NextResponse } from 'next/server'
import { isFailure } from '@/lib/portal/login-email-change'
import { refusal } from '@/lib/portal/login-email-change-http'
import { applyLoginEmailUndo } from '@/lib/portal/login-email-change-service'
import { checkRateLimit, getRateLimitKey } from '@/lib/portal/rate-limit'

export const dynamic = 'force-dynamic'

/**
 * POST /api/portal/undo-email-change — the "This wasn't me" button in the note sent to the OLD address (dev job beb43385).
 * PUBLIC on purpose (listed in middleware PUBLIC_PREFIXES): the person is not logged in, and the single-use link itself proves
 * they can open the old mailbox. Body: { token, password, repeat }. Puts the old email back and sets a new password, which
 * ends every open session of that login.
 */
export async function POST(request: NextRequest) {
  const limit = checkRateLimit(getRateLimitKey(request), 10, 60_000)
  if (!limit.allowed) return refusal('rate_limited', { retryAfterSeconds: limit.retryAfter })
  const body = await request.json().catch(() => ({}))
  const result = await applyLoginEmailUndo({ token: body.token, password: body.password, repeat: body.repeat })
  if (isFailure(result)) return refusal(result.code)
  return NextResponse.json(result)
}
