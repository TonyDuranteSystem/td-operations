import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { checkRateLimit, getRateLimitKey } from '@/lib/portal/rate-limit'
import { callAI } from '@/lib/portal/ai-provider'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/internal/polish
 * Grammar and clarity polish for internal team messages.
 * Simpler than the client-facing polish — no client context or KB lookup.
 */
export async function POST(request: NextRequest) {
  const rl = checkRateLimit(getRateLimitKey(request) + ':internal-polish', 20, 60_000)
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests. Please wait.' }, { status: 429 })
  }

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }

  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: 'AI not configured' }, { status: 503 })
  }

  const { message } = await request.json()
  if (!message?.trim()) {
    return NextResponse.json({ error: 'message required' }, { status: 400 })
  }

  const systemPrompt = `You are a writing assistant for an internal team chat between two colleagues at a tax/business consulting firm.

Fix grammar, punctuation, and clarity. Keep the tone casual, direct, and professional — this is internal, not client-facing.
Preserve the original meaning exactly. Do not add information that wasn't there.
Output ONLY the corrected message — no preamble, no commentary.`

  try {
    const result = await callAI({
      systemPrompt,
      userPrompt: message,
      maxTokens: 400,
      temperature: 0.3,
    })
    return NextResponse.json({ polished: result.text, provider: result.provider })
  } catch (err) {
    console.error('[internal/polish]', err)
    return NextResponse.json({ error: 'Failed to polish message' }, { status: 500 })
  }
}
