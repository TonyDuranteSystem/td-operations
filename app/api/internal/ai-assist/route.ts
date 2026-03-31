import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { callAI } from '@/lib/portal/ai-provider'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/internal/ai-assist
 * AI assistant for portal chats — reads conversation context and answers questions.
 * Body: { account_id, user_message, context_type: 'client_chat' | 'internal_thread', thread_id? }
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const body = await request.json()
  const { account_id, user_message, context_type, thread_id } = body

  if (!account_id || !user_message?.trim()) {
    return NextResponse.json({ error: 'account_id and user_message required' }, { status: 400 })
  }

  try {
    // Build context from CRM
    const [accountRes, servicesRes, deadlinesRes, paymentsRes] = await Promise.all([
      supabaseAdmin.from('accounts').select('company_name, entity_type, state_of_formation, ein, status, notes').eq('id', account_id).single(),
      supabaseAdmin.from('service_deliveries').select('service_type, current_stage, status, notes').eq('account_id', account_id).eq('status', 'active').limit(10),
      supabaseAdmin.from('deadlines').select('deadline_type, due_date, status').eq('account_id', account_id).eq('status', 'Pending').limit(10),
      supabaseAdmin.from('payments').select('amount, currency, status, payment_type, due_date').eq('account_id', account_id).order('created_at', { ascending: false }).limit(5),
    ])

    const account = accountRes.data
    const services = servicesRes.data ?? []
    const deadlines = deadlinesRes.data ?? []
    const payments = paymentsRes.data ?? []

    // Get recent conversation messages
    let conversationContext = ''
    if (context_type === 'client_chat') {
      const { data: msgs } = await supabaseAdmin
        .from('portal_messages')
        .select('sender_type, message, created_at')
        .eq('account_id', account_id)
        .order('created_at', { ascending: false })
        .limit(20)
      if (msgs?.length) {
        conversationContext = 'Recent client chat messages:\n' +
          msgs.reverse().map(m => `[${m.sender_type}] ${m.message}`).join('\n')
      }
    } else if (context_type === 'internal_thread' && thread_id) {
      const { data: msgs } = await supabaseAdmin
        .from('internal_messages')
        .select('sender_name, message, created_at')
        .eq('thread_id', thread_id)
        .order('created_at', { ascending: false })
        .limit(20)
      if (msgs?.length) {
        conversationContext = 'Recent internal team messages:\n' +
          msgs.reverse().map(m => `[${m.sender_name}] ${m.message}`).join('\n')
      }
    }

    // Search KB for relevant business rules
    let kbContext = ''
    try {
      const { data: articles } = await supabaseAdmin
        .from('knowledge_articles')
        .select('title, content')
        .textSearch('content', user_message.split(' ').slice(0, 5).join(' & '), { type: 'websearch' })
        .limit(3)
      if (articles?.length) {
        kbContext = 'Relevant business rules:\n' +
          articles.map(a => `- ${a.title}: ${a.content.slice(0, 200)}`).join('\n')
      }
    } catch {
      // text search may fail with certain inputs, non-critical
    }

    const systemPrompt = `You are an AI assistant for Tony Durante LLC, a US-based company that helps foreign entrepreneurs form and manage US LLCs.

You are helping the admin team (Antonio and Luca) with client management. You have access to the client's CRM data and conversation history.

Client: ${account?.company_name ?? 'Unknown'}
Entity: ${account?.entity_type ?? 'N/A'} | State: ${account?.state_of_formation ?? 'N/A'} | EIN: ${account?.ein ?? 'N/A'}
Status: ${account?.status ?? 'N/A'}
${account?.notes ? `Notes: ${account.notes.slice(0, 300)}` : ''}

Active Services: ${services.length ? services.map(s => `${s.service_type} (${s.current_stage})`).join(', ') : 'None'}
Pending Deadlines: ${deadlines.length ? deadlines.map(d => `${d.deadline_type} due ${d.due_date}`).join(', ') : 'None'}
Recent Payments: ${payments.length ? payments.map(p => `${p.amount} ${p.currency} (${p.status})`).join(', ') : 'None'}

${kbContext}

${conversationContext}

Be helpful, concise, and practical. If suggesting a reply to the client, write it ready to use. If analyzing a situation, be direct about what needs to happen. Respond in the same language the admin uses.`

    const result = await callAI({
      systemPrompt,
      userPrompt: user_message.trim(),
      maxTokens: 800,
      temperature: 0.7,
    })

    return NextResponse.json({ reply: result.text, provider: result.provider })
  } catch (err) {
    console.error('AI assist error:', err)
    return NextResponse.json({ error: 'AI request failed' }, { status: 500 })
  }
}
