import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isClient } from '@/lib/portal-auth'
import { checkRateLimit, getRateLimitKey } from '@/lib/portal/rate-limit'
import { callAI } from '@/lib/portal/ai-provider'
import { getCommSettings } from '@/lib/td-communication/comm-settings'
import { listQuestions } from '@/lib/td-communication/questions-queries'
import { selectAnswerContext, buildFieldAssistPrompt } from '@/lib/td-communication/ai-assist-context'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * POST /api/td-communication/ai/generate
 * Draft one brand-audit answer for the client to edit (the wizard ✨ button).
 * Client-only. The server re-derives the reference context from the question set
 * (never trusts raw client answers as prompt) and localizes the output.
 * Body: { questionKey, questionLabel, answers, locale }.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // Rate limit: a client shouldn't fire more than ~10 drafts/min.
  const rl = checkRateLimit(getRateLimitKey(request) + ':td-comm-ai-generate', 10, 60_000)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please wait a moment and try again.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter ?? 10) } },
    )
  }

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isClient(user)) {
    return NextResponse.json({ error: 'Portal access required.' }, { status: 403 })
  }

  // Master kill-switch (CRM Settings tab) — off = no model call.
  const settings = await getCommSettings()
  if (!settings.ai_enabled) {
    return NextResponse.json({ error: 'AI assistance is temporarily disabled.' }, { status: 503 })
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'AI is not configured.' }, { status: 503 })
  }

  let body: { questionKey?: unknown; questionLabel?: unknown; answers?: unknown; locale?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }

  const questionKey = typeof body.questionKey === 'string' ? body.questionKey : ''
  const questionLabel = typeof body.questionLabel === 'string' ? body.questionLabel.trim() : ''
  const answers = (body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers))
    ? (body.answers as Record<string, unknown>)
    : {}
  const locale = body.locale === 'it' ? 'it' : 'en'
  if (!questionLabel) {
    return NextResponse.json({ error: 'questionLabel is required.' }, { status: 400 })
  }

  try {
    // Authoritative context: filter the client's own answers via the question set
    // (drops files/flags/uploads), excluding the field being written.
    const questions = await listQuestions()
    const context = selectAnswerContext(answers, questions, questionKey)
    if (context.length === 0) {
      return NextResponse.json(
        { error: 'Add a few details in the other questions first, then AI can help draft this one.' },
        { status: 400 },
      )
    }

    const { systemPrompt, userPrompt } = buildFieldAssistPrompt({ questionLabel, context, locale })
    const result = await callAI({ systemPrompt, userPrompt, maxTokens: 400, temperature: 0.6 })
    return NextResponse.json({ text: result.text })
  } catch (err) {
    console.error('[td-comm ai/generate] error:', err)
    return NextResponse.json({ error: 'Could not generate a draft right now. Please try again.' }, { status: 500 })
  }
}
