import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { checkRateLimit, getRateLimitKey } from '@/lib/portal/rate-limit'
import { callAI } from '@/lib/portal/ai-provider'
import { fetchKBContext, buildKBQuery } from '@/lib/portal/kb-context'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/portal/chat/suggest
 * AI-powered reply suggestion for admin. Learns from past admin messages + KB Brain.
 *
 * 1. Loads KB articles + approved responses matching conversation topic
 * 2. Loads admin's past replies across ALL clients (style examples)
 * 3. Loads this client's account context (services, deadlines, payments)
 * 4. Loads conversation history with this client
 * 5. Generates a reply via Claude Haiku (primary) or GPT-4o-mini (fallback)
 */
export async function POST(request: NextRequest) {
  // Rate limit: max 6 suggestions per minute (AI calls)
  const rl = checkRateLimit(getRateLimitKey(request) + ':suggest', 6, 60_000)
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

  const { account_id, contact_id } = await request.json()
  if (!account_id && !contact_id) {
    return NextResponse.json({ error: 'account_id or contact_id required' }, { status: 400 })
  }

  try {
    // 1. Get client account info (if available)
    let account = null
    let services = null
    let deadlines = null
    let payments = null

    if (account_id) {
      const { data: acct } = await supabaseAdmin
        .from('accounts')
        .select('company_name, entity_type, state_of_formation, status, ein_number')
        .eq('id', account_id)
        .single()
      account = acct

      // 2. Get active services for this client
      const { data: svc } = await supabaseAdmin
        .from('services')
        .select('service_name, service_type, status, current_step, total_steps')
        .eq('account_id', account_id)
        .in('status', ['Not Started', 'In Progress', 'Waiting Client', 'Waiting Third Party'])
        .limit(10)
      services = svc

      // 3. Get upcoming deadlines
      const today = new Date().toISOString().split('T')[0]
      const { data: dl } = await supabaseAdmin
        .from('deadlines')
        .select('deadline_type, due_date, status')
        .eq('account_id', account_id)
        .in('status', ['Pending', 'Overdue'])
        .gte('due_date', today)
        .order('due_date')
        .limit(5)
      deadlines = dl

      // 4. Get recent payments
      const { data: pay } = await supabaseAdmin
        .from('payments')
        .select('description, amount, status, due_date')
        .eq('account_id', account_id)
        .order('due_date', { ascending: false })
        .limit(5)
      payments = pay
    }

    // If no account but we have contact, get contact info for context
    let contactInfo = null
    if (!account_id && contact_id) {
      const { data: ct } = await supabaseAdmin
        .from('contacts')
        .select('full_name, email, language, citizenship')
        .eq('id', contact_id)
        .single()
      contactInfo = ct
    }

    // 5. Get this conversation (last 20 messages)
    let conversationQuery = supabaseAdmin
      .from('portal_messages')
      .select('sender_type, message, created_at')
      .order('created_at', { ascending: false })
      .limit(20)

    if (account_id) {
      conversationQuery = conversationQuery.eq('account_id', account_id)
    } else {
      conversationQuery = conversationQuery.eq('contact_id', contact_id).is('account_id', null)
    }

    const { data: conversation } = await conversationQuery
    const conversationHistory = (conversation ?? []).reverse()

    // 6. Get admin's past replies from OTHER conversations (style examples)
    const { data: styleExamples } = await supabaseAdmin
      .from('portal_messages')
      .select('message, account_id')
      .eq('sender_type', 'admin')
      .neq('account_id', account_id)
      .not('message', 'eq', '')
      .order('created_at', { ascending: false })
      .limit(50)

    // Deduplicate by picking unique-ish messages (different content)
    const seenMessages = new Set<string>()
    const uniqueExamples: string[] = []
    for (const ex of styleExamples ?? []) {
      const key = ex.message.slice(0, 50).toLowerCase()
      if (!seenMessages.has(key) && ex.message.length > 10) {
        seenMessages.add(key)
        uniqueExamples.push(ex.message)
        if (uniqueExamples.length >= 15) break
      }
    }

    // 7. Get admin replies IN this conversation (for consistency)
    const adminRepliesInThread = conversationHistory
      .filter(m => m.sender_type === 'admin')
      .map(m => m.message)
      .slice(-5)

    // 8. Fetch KB Brain context (approved responses + business rules)
    const lastClientMessage = conversationHistory
      .filter(m => m.sender_type !== 'admin')
      .slice(-1)[0]?.message ?? ''

    const serviceKeywords = (services ?? []).map(s => s.service_type).filter(Boolean)
    const kbQuery = buildKBQuery(lastClientMessage, [account?.entity_type ?? '', ...serviceKeywords])
    const kbContext = await fetchKBContext(kbQuery)

    // 9. Build the context
    const clientContext = [
      `Company: ${account?.company_name || contactInfo?.full_name || 'Unknown'}`,
      account?.entity_type ? `Entity: ${account.entity_type}` : '',
      account?.state_of_formation ? `State: ${account.state_of_formation}` : '',
      account?.ein_number ? `EIN: ${account.ein_number}` : '',
      '',
      services?.length ? `Active Services:\n${services.map(s => `- ${s.service_name} (${s.status}${s.current_step && s.total_steps ? `, step ${s.current_step}/${s.total_steps}` : ''})`).join('\n')}` : 'No active services.',
      '',
      deadlines?.length ? `Upcoming Deadlines:\n${deadlines.map(d => `- ${d.deadline_type}: ${d.due_date} (${d.status})`).join('\n')}` : 'No upcoming deadlines.',
      '',
      payments?.length ? `Recent Payments:\n${payments.map(p => `- ${p.description || 'Payment'}: $${p.amount} (${p.status})`).join('\n')}` : '',
    ].filter(Boolean).join('\n')

    const conversationText = conversationHistory
      .map(m => `${m.sender_type === 'admin' ? 'Admin' : 'Client'}: ${m.message}`)
      .join('\n')

    const systemPrompt = `You are an AI assistant that helps Antonio (admin of Tony Durante LLC, a US business formation and tax consulting company) draft replies to client portal messages.

YOUR JOB: Generate a reply that sounds EXACTLY like Antonio would write it. Match his tone, style, and level of detail.

ANTONIO'S COMMUNICATION STYLE (learned from his past messages):
${uniqueExamples.length > 0 ? uniqueExamples.map((m, i) => `${i + 1}. "${m}"`).join('\n') : 'No past examples yet — use a professional but friendly tone.'}

${adminRepliesInThread.length > 0 ? `\nANTONIO'S REPLIES IN THIS SPECIFIC CONVERSATION:\n${adminRepliesInThread.map((m, i) => `${i + 1}. "${m}"`).join('\n')}` : ''}

CLIENT ACCOUNT CONTEXT:
${clientContext}

${kbContext ? `\n${kbContext}` : ''}

RULES:
- Write the reply as if you ARE Antonio. Don't say "I suggest..." — just write the actual reply.
- ALWAYS reply in English. Even if the client writes in Italian or another language, your reply MUST be in English. This is a strict rule.
- Be specific — reference their actual services, deadlines, or payments when relevant.
- Keep it concise but helpful. Don't over-explain.
- If the client is asking something you don't have data for, acknowledge it and say you'll check and get back to them.
- Don't make up information that's not in the context.
- Be warm but professional — this is a premium service.`

    const userPrompt = `Here is the conversation:\n\n${conversationText}\n\nThe client just sent the last message. Write Antonio's reply:`

    const result = await callAI({
      systemPrompt,
      userPrompt,
      maxTokens: 500,
      temperature: 0.7,
    })

    return NextResponse.json({ suggestion: result.text, provider: result.provider })
  } catch (err: unknown) {
    console.error('[suggest] Error:', err)
    return NextResponse.json({ error: 'Failed to generate suggestion' }, { status: 500 })
  }
}
