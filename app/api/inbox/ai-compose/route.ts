import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { checkRateLimit, getRateLimitKey } from '@/lib/portal/rate-limit'
import { callAI } from '@/lib/portal/ai-provider'
import { fetchKBContext, buildKBQuery } from '@/lib/portal/kb-context'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/inbox/ai-compose
 * AI-powered email drafting for new emails.
 * Takes a brief instruction + optional recipient context, generates a full professional email.
 */
export async function POST(request: NextRequest) {
  const rl = checkRateLimit(getRateLimitKey(request) + ':inbox-compose', 8, 60_000)
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

  const { instruction, to, subject, language } = await request.json()
  if (!instruction?.trim()) {
    return NextResponse.json({ error: 'instruction required' }, { status: 400 })
  }

  try {
    // Look up recipient in CRM for context
    let account = null
    let contactName = ''
    if (to) {
      const { data: contact } = await supabaseAdmin
        .from('contacts')
        .select('id, full_name, language, account_contacts(account_id)')
        .or(`email.eq.${to},email_2.eq.${to}`)
        .limit(1)
        .maybeSingle()

      if (contact) {
        contactName = contact.full_name ?? ''
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const acJunction = contact.account_contacts as any[]
        const accountId = acJunction?.[0]?.account_id

        if (accountId) {
          const { data: acct } = await supabaseAdmin
            .from('accounts')
            .select('company_name, entity_type, state_of_formation, status')
            .eq('id', accountId)
            .single()
          account = acct
        }
      }
    }

    // Fetch KB context from instruction
    const kbQuery = buildKBQuery(instruction)
    const kbContext = await fetchKBContext(kbQuery)

    // Get admin's past email style
    const { data: pastEmails } = await supabaseAdmin
      .from('action_log')
      .select('summary')
      .in('action_type', ['email', 'email_sent'])
      .order('created_at', { ascending: false })
      .limit(15)

    const styleExamples = (pastEmails ?? [])
      .map(e => e.summary)
      .filter(s => s && s.length > 30)
      .slice(0, 6)

    const lang = language || 'English'

    const systemPrompt = `You are an AI email assistant for Antonio, who runs Tony Durante LLC (US business formation & tax consulting).

YOUR JOB: Write a professional email based on Antonio's instructions. Write as if you ARE Antonio.

${subject ? `SUBJECT: ${subject}` : ''}
${contactName ? `RECIPIENT: ${contactName}` : to ? `RECIPIENT: ${to}` : ''}
${account ? `CLIENT COMPANY: ${account.company_name} (${account.entity_type || ''}, ${account.state_of_formation || ''})` : ''}

${styleExamples.length > 0 ? `ANTONIO'S EMAIL STYLE (examples):\n${styleExamples.map((s, i) => `${i + 1}. "${s}"`).join('\n')}` : ''}

${kbContext ? `\n${kbContext}` : ''}

RULES:
- Write in ${lang} unless the instruction specifies otherwise.
- Output ONLY the email body — no "Subject:" line, no explanations.
- Include a greeting and professional sign-off.
- Be clear, concise, and warm.
- Don't make up facts not in the instruction or context.
- If Antonio's instruction is brief, expand it into a complete professional email.`

    const result = await callAI({
      systemPrompt,
      userPrompt: `Antonio's instruction: "${instruction}"`,
      maxTokens: 600,
      temperature: 0.6,
    })

    return NextResponse.json({ draft: result.text, provider: result.provider })
  } catch (err: unknown) {
    console.error('[inbox/ai-compose] Error:', err)
    return NextResponse.json({ error: 'Failed to generate draft' }, { status: 500 })
  }
}
