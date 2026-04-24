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

  const { message, account_id, contact_id } = await request.json()
  if (!message?.trim()) return NextResponse.json({ error: 'message required' }, { status: 400 })

  try {
    // 1. Account + client info
    let companyName = ''
    let clientLanguage = ''
    let entityType = ''
    let stateOfFormation = ''

    if (account_id) {
      const { data: account } = await supabaseAdmin
        .from('accounts')
        .select('company_name, entity_type, state_of_formation')
        .eq('id', account_id)
        .single()
      companyName = account?.company_name || ''
      entityType = account?.entity_type || ''
      stateOfFormation = account?.state_of_formation || ''

      // Language from primary contact
      const { data: primaryAc } = await supabaseAdmin
        .from('account_contacts')
        .select('contacts(language)')
        .eq('account_id', account_id)
        .eq('is_primary', true)
        .limit(1)
        .maybeSingle()
      const lang = (primaryAc?.contacts as { language?: string | null } | null)?.language
      clientLanguage = lang || ''
    } else if (contact_id) {
      const { data: contact } = await supabaseAdmin
        .from('contacts')
        .select('language, full_name')
        .eq('id', contact_id)
        .single()
      clientLanguage = contact?.language || ''
      companyName = contact?.full_name || ''
    }

    const isItalian = clientLanguage === 'it' || clientLanguage === 'Italian'
    const isEnglish = clientLanguage === 'en' || clientLanguage === 'English'
    const targetLanguage = isItalian ? 'Italian' : isEnglish ? 'English' : clientLanguage || null

    // 2. Active services
    let services: { service_name: string; status: string }[] = []
    if (account_id) {
      const { data: svc } = await supabaseAdmin
        .from('service_deliveries')
        .select('service_name, status')
        .eq('account_id', account_id)
        .eq('status', 'active')
        .limit(8)
      services = svc ?? []
    }

    // 3. Upcoming deadlines
    let deadlines: { deadline_type: string; due_date: string; status: string }[] = []
    if (account_id) {
      const today = new Date().toISOString().split('T')[0]
      const { data: dl } = await supabaseAdmin
        .from('deadlines')
        .select('deadline_type, due_date, status')
        .eq('account_id', account_id)
        .in('status', ['Pending', 'Overdue'])
        .gte('due_date', today)
        .order('due_date')
        .limit(5)
      deadlines = dl ?? []
    }

    // 4. Conversation history (last 15 messages) — critical for context
    let conversationQuery = supabaseAdmin
      .from('portal_messages')
      .select('sender_type, message, created_at')
      .order('created_at', { ascending: false })
      .limit(15)
    if (account_id) {
      conversationQuery = conversationQuery.eq('account_id', account_id)
    } else {
      conversationQuery = conversationQuery.eq('contact_id', contact_id).is('account_id', null)
    }
    const { data: conversation } = await conversationQuery
    const conversationHistory = (conversation ?? []).reverse()

    // 5. Style examples from admin's past messages (other threads)
    const { data: styleMessages } = await supabaseAdmin
      .from('portal_messages')
      .select('message')
      .eq('sender_type', 'admin')
      .not('message', 'eq', '')
      .order('created_at', { ascending: false })
      .limit(20)
    const styleExamples = (styleMessages ?? [])
      .filter(m => m.message.length > 20)
      .slice(0, 6)
      .map(m => m.message)

    // 6. KB Brain context
    const kbQuery = buildKBQuery(message)
    const kbContext = await fetchKBContext(kbQuery)

    // Build context block
    const clientContext = [
      companyName ? `Client: ${companyName}` : '',
      entityType ? `Entity: ${entityType}` : '',
      stateOfFormation ? `State: ${stateOfFormation}` : '',
      services.length ? `Active services: ${services.map(s => s.service_name).join(', ')}` : '',
      deadlines.length ? `Upcoming deadlines: ${deadlines.map(d => `${d.deadline_type} (${d.due_date})`).join(', ')}` : '',
    ].filter(Boolean).join('\n')

    const conversationText = conversationHistory.length
      ? conversationHistory.map(m => `${m.sender_type === 'admin' ? 'Antonio' : 'Client'}: ${m.message}`).join('\n')
      : ''

    const systemPrompt = `You are a writing assistant for Antonio, who runs Tony Durante LLC (US business formation & tax consulting).

YOUR JOB: Take Antonio's rough draft and rewrite it as a clean, professional message to the client.

${clientContext ? `CLIENT CONTEXT:\n${clientContext}\n` : ''}
${conversationText ? `RECENT CONVERSATION (use this to understand what Antonio is responding to):\n${conversationText}\n` : ''}
${kbContext ? `${kbContext}\n` : ''}
RULES:
- ${targetLanguage ? `ALWAYS output in ${targetLanguage}, regardless of the language of the draft. Translate if necessary.` : 'Keep the SAME language as the draft.'}
- Keep the SAME meaning and information — do not add facts that Antonio did not mention.
- Fix grammar, punctuation, and sentence structure.
- Make it clear, concise, professional but warm — not robotic.
- Add a brief greeting only if the draft doesn't already have one.
- If the message mentions specific services, steps, or deadlines, present them clearly (bullet points if helpful).
- Output ONLY the polished message — no preamble, no "here's the rewrite", just the message itself.
${styleExamples.length > 0 ? `\nANTONIO'S WRITING STYLE (examples):\n${styleExamples.map((m, i) => `${i + 1}. "${m}"`).join('\n')}` : ''}`

    const result = await callAI({
      systemPrompt,
      userPrompt: `Antonio's rough draft:\n\n${message}`,
      maxTokens: 600,
      temperature: 0.5,
    })

    return NextResponse.json({ polished: result.text, provider: result.provider })
  } catch (err: unknown) {
    console.error('[polish] Error:', err)
    return NextResponse.json({ error: 'Failed to polish message' }, { status: 500 })
  }
}
