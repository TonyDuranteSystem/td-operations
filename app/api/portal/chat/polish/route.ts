import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { checkRateLimit, getRateLimitKey } from '@/lib/portal/rate-limit'
import { callAI } from '@/lib/portal/ai-provider'
import { fetchKBContext, buildKBQuery } from '@/lib/portal/kb-context'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/portal/chat/polish
 * Rewrites a rough admin message into clean, professional form.
 * Uses KB Brain for tone/style reference, then Claude Haiku (primary) or GPT-4o-mini (fallback).
 */
export async function POST(request: NextRequest) {
  // Rate limit: max 12 polishes per minute
  const rl = checkRateLimit(getRateLimitKey(request) + ':polish', 12, 60_000)
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests. Please wait.' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfter ?? 10) } })
  }

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }

  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: 'AI not configured' }, { status: 503 })
  }

  const { message, account_id } = await request.json()
  if (!message?.trim()) return NextResponse.json({ error: 'message required' }, { status: 400 })

  try {
    // Get company name for context
    let companyName = ''
    if (account_id) {
      const { data: account } = await supabaseAdmin
        .from('accounts')
        .select('company_name')
        .eq('id', account_id)
        .single()
      companyName = account?.company_name || ''
    }

    // Get admin's past polished messages for style reference
    const { data: styleMessages } = await supabaseAdmin
      .from('portal_messages')
      .select('message')
      .eq('sender_type', 'admin')
      .not('message', 'eq', '')
      .order('created_at', { ascending: false })
      .limit(20)

    const styleExamples = (styleMessages ?? [])
      .filter(m => m.message.length > 20)
      .slice(0, 8)
      .map(m => m.message)

    // Fetch KB Brain context matching the message content
    const kbQuery = buildKBQuery(message)
    const kbContext = await fetchKBContext(kbQuery)

    const systemPrompt = `You are a writing assistant for Antonio, who runs Tony Durante LLC (US business formation & tax consulting).

YOUR JOB: Rewrite his rough message into a clean, professional version.

RULES:
- Keep the SAME language as the input (if Italian, output Italian. If English, output English).
- Keep the SAME meaning and information — don't add facts he didn't mention.
- Fix grammar, punctuation, and sentence structure.
- Make it clear, concise, and professional but warm.
- Add a brief greeting if appropriate (e.g., "Ciao [name]," or "Hi,").
- Don't make it overly formal or robotic — it should sound natural, like a knowledgeable professional.
- If the message mentions specific services, deadlines, or steps, present them clearly (bullet points if helpful).
- Output ONLY the polished message — no explanations, no "here's the rewritten version", just the message itself.

${styleExamples.length > 0 ? `ANTONIO'S WRITING STYLE (examples from past messages):\n${styleExamples.map((m, i) => `${i + 1}. "${m}"`).join('\n')}` : ''}

${kbContext ? `\n${kbContext}` : ''}

${companyName ? `CLIENT COMPANY: ${companyName}` : ''}`

    const result = await callAI({
      systemPrompt,
      userPrompt: `Rewrite this message:\n\n${message}`,
      maxTokens: 500,
      temperature: 0.5,
    })

    return NextResponse.json({ polished: result.text, provider: result.provider })
  } catch (err: unknown) {
    console.error('[polish] Error:', err)
    return NextResponse.json({ error: 'Failed to polish message' }, { status: 500 })
  }
}
