import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { checkRateLimit, getRateLimitKey } from '@/lib/portal/rate-limit'
import { callAI } from '@/lib/portal/ai-provider'
import { fetchKBContext, buildKBQuery } from '@/lib/portal/kb-context'
import { gmailGet, extractBody, getHeader, isOwnMailboxAddress } from '@/lib/gmail'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/inbox/ai-suggest
 * AI-powered reply suggestion for Gmail threads.
 * Loads thread context, CRM account data, KB Brain, and past email style to generate a reply.
 */
export async function POST(request: NextRequest) {
  const rl = checkRateLimit(getRateLimitKey(request) + ':inbox-suggest', 6, 60_000)
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

  const { threadId, mailbox, messageId: targetMessageId } = await request.json()
  if (!threadId) {
    return NextResponse.json({ error: 'threadId required' }, { status: 400 })
  }

  try {
    const asUser = mailbox === 'antonio'
      ? 'antonio.durante@tonydurante.us'
      : 'support@tonydurante.us'

    // 1. Get the Gmail thread
    const thread = await gmailGet(`/threads/${threadId}`, { format: 'full' }, asUser)
    if (!thread?.messages?.length) {
      return NextResponse.json({ error: 'Thread not found' }, { status: 404 })
    }

    // 2. Extract conversation from thread
    const messages = thread.messages.map((msg: Record<string, unknown>) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const payload = msg.payload as any
      const headers = payload?.headers ?? []
      const from = getHeader(headers, 'From') ?? ''
      const body = extractBody(payload) ?? ''
      const isAdmin = isOwnMailboxAddress(from)
      return { id: msg.id as string, from, body: body.slice(0, 1000), isAdmin }
    })

    // Same "which message" resolution as Reply/Draft (lib/inbox/reply-target.ts,
    // duplicated here in-line since this route already has the thread in
    // hand): an explicit pick from the client, else the newest message NOT
    // sent by us, else — nothing else sent us anything yet — the literal
    // newest. Previously this always used the thread's literal newest
    // message, which resolved the WRONG contact's CRM context whenever our
    // own prior reply happened to be newest (the exact condition behind both
    // confirmed misdirect incidents).
    const targetIndex = targetMessageId
      ? messages.findIndex((m: { id: string }) => m.id === targetMessageId)
      : -1
    const fallbackIndex = (() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (!messages[i].isAdmin) return i
      }
      return messages.length - 1
    })()
    const resolvedIndex = targetIndex >= 0 ? targetIndex : fallbackIndex
    const targetMessage = messages[resolvedIndex]
    const senderEmail = targetMessage?.from?.match(/<([^>]+)>/)?.[1] ?? targetMessage?.from ?? ''
    const subject = getHeader(thread.messages[0]?.payload?.headers ?? [], 'Subject') ?? ''

    // 3. Look up sender in CRM
    let account = null
    let services = null
    let deadlines = null
    let payments = null

    if (senderEmail) {
      const { data: contact } = await supabaseAdmin
        .from('contacts')
        .select('id, full_name, email, account_contacts(account_id)')
        .or(`email.eq.${senderEmail},email_2.eq.${senderEmail}`)
        .limit(1)
        .maybeSingle()

      if (contact) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const acJunction = contact.account_contacts as any[]
        const accountId = acJunction?.[0]?.account_id

        if (accountId) {
          const [acctResult, svcResult, dlResult, payResult] = await Promise.all([
            supabaseAdmin
              .from('accounts')
              .select('company_name, entity_type, state_of_formation, status, ein_number')
              .eq('id', accountId)
              .single(),
            supabaseAdmin
              .from('service_deliveries')
              .select('service_name, service_type, stage, status')
              .eq('account_id', accountId)
              .eq('status', 'active')
              .limit(10),
            supabaseAdmin
              .from('deadlines')
              .select('deadline_type, due_date, status')
              .eq('account_id', accountId)
              .in('status', ['Pending', 'Overdue'])
              .order('due_date')
              .limit(5),
            supabaseAdmin
              .from('payments')
              .select('description, amount, status, due_date')
              .eq('account_id', accountId)
              .order('due_date', { ascending: false })
              .limit(5),
          ])
          account = acctResult.data
          services = svcResult.data
          deadlines = dlResult.data
          payments = payResult.data
        }
      }
    }

    // 4. Get admin's past email style from action_log
    const { data: pastEmails } = await supabaseAdmin
      .from('action_log')
      .select('summary')
      .in('action_type', ['email', 'email_sent'])
      .order('created_at', { ascending: false })
      .limit(20)

    const styleExamples = (pastEmails ?? [])
      .map(e => e.summary)
      .filter(s => s && s.length > 30)
      .slice(0, 8)

    // 5. Fetch KB context
    const kbQuery = buildKBQuery(
      targetMessage?.body?.slice(0, 100) ?? subject,
      services?.map(s => s.service_type).filter(Boolean) as string[] ?? []
    )
    const kbContext = await fetchKBContext(kbQuery)

    // 6. Build context
    const clientContext = [
      account ? `Company: ${account.company_name}` : '',
      account?.entity_type ? `Entity: ${account.entity_type}` : '',
      account?.state_of_formation ? `State: ${account.state_of_formation}` : '',
      account?.ein_number ? `EIN: ${account.ein_number}` : '',
      services?.length ? `\nActive Services:\n${services.map(s => `- ${s.service_name} (${s.status})`).join('\n')}` : '',
      deadlines?.length ? `\nUpcoming Deadlines:\n${deadlines.map(d => `- ${d.deadline_type}: ${d.due_date} (${d.status})`).join('\n')}` : '',
      payments?.length ? `\nRecent Payments:\n${payments.map(p => `- ${p.description || 'Payment'}: $${p.amount} (${p.status})`).join('\n')}` : '',
    ].filter(Boolean).join('\n')

    // The target message is marked explicitly rather than relying on "the
    // latest one" — it may not be, when staff (or the frozen default)
    // targeted an earlier message in the thread. A version of this bug that
    // only fixed WHO the reply's CRM context resolves to, while still
    // telling the model to answer "the latest message", would draft a
    // reply with the right company facts answering the wrong question —
    // more dangerous than the original bug because it reads as trustworthy.
    const threadText = messages
      .map((m: { isAdmin: boolean; body: string }, i: number) =>
        `${m.isAdmin ? 'Antonio' : 'Client'}${i === resolvedIndex ? ' [THIS IS THE MESSAGE TO REPLY TO]' : ''}: ${m.body}`
      )
      .join('\n---\n')

    const systemPrompt = `You are an AI email assistant for Antonio, who runs Tony Durante LLC (US business formation & tax consulting).

YOUR JOB: Draft a professional email reply to the message marked "[THIS IS THE MESSAGE TO REPLY TO]" below — NOT necessarily the last message in the thread. Write as if you ARE Antonio.

SUBJECT: ${subject}

${styleExamples.length > 0 ? `ANTONIO'S EMAIL STYLE (from past emails):\n${styleExamples.map((s, i) => `${i + 1}. "${s}"`).join('\n')}` : ''}

${clientContext ? `\nCLIENT CONTEXT:\n${clientContext}` : ''}

${kbContext ? `\n${kbContext}` : ''}

RULES:
- Write the reply directly — no "Here's a draft" preamble. Just the email body.
- PLAIN TEXT ONLY — this goes into an email as-is. NEVER use markdown (**bold**, bullets with * or -, # headings). The client would see the raw asterisks.
- Match the language of the incoming email (Italian if they wrote in Italian, English if English).
- Be professional, warm, and concise.
- Reference specific services, deadlines, or payments when relevant.
- Don't make up facts not in the context.
- Include a greeting (e.g., "Hi [Name]," or "Ciao [Nome],") and a sign-off.
- If you don't have enough context, acknowledge and say you'll follow up.`

    const result = await callAI({
      systemPrompt,
      userPrompt: `Email thread:\n\n${threadText}\n\nDraft Antonio's reply to the message marked [THIS IS THE MESSAGE TO REPLY TO] above:`,
      maxTokens: 600,
      temperature: 0.7,
    })

    return NextResponse.json({ suggestion: result.text, provider: result.provider })
  } catch (err: unknown) {
    console.error('[inbox/ai-suggest] Error:', err)
    return NextResponse.json({ error: 'Failed to generate suggestion' }, { status: 500 })
  }
}
