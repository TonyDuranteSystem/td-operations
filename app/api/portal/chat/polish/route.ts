import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { checkRateLimit, getRateLimitKey } from '@/lib/portal/rate-limit'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/portal/chat/polish
 * Rewrites a rough admin message into clean, professional form.
 * Keeps the same meaning and language, but fixes grammar,
 * adds clarity, and makes it sound polished.
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

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
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

${companyName ? `CLIENT COMPANY: ${companyName}` : ''}`

    // 30s timeout
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Rewrite this message:\n\n${message}` },
        ],
        max_tokens: 500,
        temperature: 0.5,
      }),
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      console.error('[polish] OpenAI error:', err)
      return NextResponse.json({ error: 'AI polishing failed' }, { status: 500 })
    }

    const result = await res.json()
    const polished = result.choices?.[0]?.message?.content?.trim() || ''

    return NextResponse.json({ polished })
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      return NextResponse.json({ error: 'AI request timed out. Please try again.' }, { status: 504 })
    }
    console.error('[polish] Error:', err)
    return NextResponse.json({ error: 'Failed to polish message' }, { status: 500 })
  }
}
