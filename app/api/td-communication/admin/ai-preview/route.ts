import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ensureStaff } from '@/lib/td-communication/admin-auth'
import { checkRateLimit, getRateLimitKey } from '@/lib/portal/rate-limit'
import { callAI } from '@/lib/portal/ai-provider'
import { getCommSettings } from '@/lib/td-communication/comm-settings'
import { buildFieldAssistPrompt } from '@/lib/td-communication/ai-assist-context'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * POST /api/td-communication/admin/ai-preview
 * Staff-only preview of what the client wizard's ✨ "Generate with AI" would
 * produce for a question — so an operator can judge the AI output from the CRM
 * Questions editor without impersonating a client. READ-ONLY: nothing is saved.
 *
 * There is no real client context here, so the operator supplies a short sample
 * business description; we frame it as the reference context and reuse the SAME
 * prompt builder + model the client route uses, so the preview matches reality.
 * Body: { questionLabel, sampleContext, locale }.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const gate = await ensureStaff(user)
  if (gate) return gate

  // Modest per-operator limit (staff, low volume, but the model costs money).
  const rl = checkRateLimit(getRateLimitKey(request) + ':td-comm-ai-preview', 20, 60_000)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many previews. Please wait a moment.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter ?? 10) } },
    )
  }

  const settings = await getCommSettings()
  if (!settings.ai_enabled) {
    return NextResponse.json({ error: 'AI features are temporarily disabled.' }, { status: 503 })
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'AI is not configured.' }, { status: 503 })
  }

  let body: { questionLabel?: unknown; sampleContext?: unknown; locale?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }
  const questionLabel = typeof body.questionLabel === 'string' ? body.questionLabel.trim() : ''
  const sampleContext = typeof body.sampleContext === 'string' ? body.sampleContext.trim() : ''
  const locale = body.locale === 'it' ? 'it' : 'en'
  if (!questionLabel) {
    return NextResponse.json({ error: 'questionLabel is required.' }, { status: 400 })
  }
  if (!sampleContext) {
    return NextResponse.json(
      { error: 'Add a short sample business description so the preview has something to work from.' },
      { status: 400 },
    )
  }

  try {
    const { systemPrompt, userPrompt } = buildFieldAssistPrompt({
      questionLabel,
      context: [{ label: 'About the business', value: sampleContext.slice(0, 600) }],
      locale,
    })
    const result = await callAI({ systemPrompt, userPrompt, maxTokens: 400, temperature: 0.6 })
    return NextResponse.json({ text: result.text })
  } catch (err) {
    console.error('[td-comm ai/admin-preview] error:', err)
    return NextResponse.json({ error: 'Could not generate a preview right now. Please try again.' }, { status: 500 })
  }
}
