import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAdmin } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/portal/chat/suggest
 * AI-powered reply suggestion for admin. Learns from past admin messages.
 *
 * 1. Loads admin's past replies across ALL clients (style examples)
 * 2. Loads this client's account context (services, deadlines, payments)
 * 3. Loads conversation history with this client
 * 4. Generates a reply that sounds like the admin
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'AI not configured' }, { status: 503 })
  }

  const { account_id } = await request.json()
  if (!account_id) return NextResponse.json({ error: 'account_id required' }, { status: 400 })

  try {
    // 1. Get client account info
    const { data: account } = await supabaseAdmin
      .from('accounts')
      .select('company_name, entity_type, state_of_formation, status, ein_number')
      .eq('id', account_id)
      .single()

    // 2. Get active services for this client
    const { data: services } = await supabaseAdmin
      .from('services')
      .select('service_name, service_type, status, current_step, total_steps')
      .eq('account_id', account_id)
      .in('status', ['Not Started', 'In Progress', 'Waiting Client', 'Waiting Third Party'])
      .limit(10)

    // 3. Get upcoming deadlines
    const today = new Date().toISOString().split('T')[0]
    const { data: deadlines } = await supabaseAdmin
      .from('deadlines')
      .select('deadline_type, due_date, status')
      .eq('account_id', account_id)
      .in('status', ['Pending', 'Overdue'])
      .gte('due_date', today)
      .order('due_date')
      .limit(5)

    // 4. Get recent payments
    const { data: payments } = await supabaseAdmin
      .from('payments')
      .select('description, amount, status, due_date')
      .eq('account_id', account_id)
      .order('due_date', { ascending: false })
      .limit(5)

    // 5. Get this conversation (last 20 messages)
    const { data: conversation } = await supabaseAdmin
      .from('portal_messages')
      .select('sender_type, message, created_at')
      .eq('account_id', account_id)
      .order('created_at', { ascending: false })
      .limit(20)

    const conversationHistory = (conversation ?? []).reverse()

    // 6. Get admin's past replies from OTHER conversations (style examples)
    // Pick diverse examples: recent + from different clients
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

    // 7. Also get admin replies IN this conversation (for consistency)
    const adminRepliesInThread = conversationHistory
      .filter(m => m.sender_type === 'admin')
      .map(m => m.message)
      .slice(-5)

    // 8. Build the context
    const clientContext = [
      `Company: ${account?.company_name || 'Unknown'}`,
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

    // 9. Call GPT-4
    const systemPrompt = `You are an AI assistant that helps Antonio (admin of Tony Durante LLC, a US business formation and tax consulting company) draft replies to client portal messages.

YOUR JOB: Generate a reply that sounds EXACTLY like Antonio would write it. Match his tone, style, and level of detail.

ANTONIO'S COMMUNICATION STYLE (learned from his past messages):
${uniqueExamples.length > 0 ? uniqueExamples.map((m, i) => `${i + 1}. "${m}"`).join('\n') : 'No past examples yet — use a professional but friendly tone.'}

${adminRepliesInThread.length > 0 ? `\nANTONIO'S REPLIES IN THIS SPECIFIC CONVERSATION:\n${adminRepliesInThread.map((m, i) => `${i + 1}. "${m}"`).join('\n')}` : ''}

CLIENT ACCOUNT CONTEXT:
${clientContext}

RULES:
- Write the reply as if you ARE Antonio. Don't say "I suggest..." — just write the actual reply.
- Match the language the client is using (if they write in Italian, reply in Italian; if English, reply in English).
- Be specific — reference their actual services, deadlines, or payments when relevant.
- Keep it concise but helpful. Don't over-explain.
- If the client is asking something you don't have data for, acknowledge it and say you'll check and get back to them.
- Don't make up information that's not in the context.
- Be warm but professional — this is a premium service.`

    const userPrompt = `Here is the conversation:\n\n${conversationText}\n\nThe client just sent the last message. Write Antonio's reply:`

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
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 500,
        temperature: 0.7,
      }),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      console.error('[suggest] OpenAI error:', err)
      return NextResponse.json({ error: 'AI generation failed' }, { status: 500 })
    }

    const result = await res.json()
    const suggestion = result.choices?.[0]?.message?.content?.trim() || ''

    return NextResponse.json({ suggestion })
  } catch (err) {
    console.error('[suggest] Error:', err)
    return NextResponse.json({ error: 'Failed to generate suggestion' }, { status: 500 })
  }
}
