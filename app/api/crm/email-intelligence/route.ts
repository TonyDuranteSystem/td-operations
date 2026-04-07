import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { gmailGet, extractBody, getHeader } from '@/lib/gmail'
import { NextResponse } from 'next/server'

export interface EmailIntelligenceItem {
  threadId: string
  from: string
  senderName: string
  senderEmail: string
  subject: string
  date: string
  category: 'new_lead' | 'service_request' | 'client_question' | 'follow_up' | 'noise'
  summary: string
  suggestedAction: string
  urgency: 'red' | 'amber' | 'green'
  isExistingContact: boolean
  contactId?: string
  accountId?: string
}

export const dynamic = 'force-dynamic'

export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: 'AI not configured' }, { status: 503 })
  }

  try {
    // 1. Fetch unread primary inbox threads (last 7 days, external senders only)
    const gmailResult = await gmailGet('/threads', {
      q: 'is:unread -from:tonydurante.us -from:noreply -from:no-reply -from:notifications -from:mailer-daemon category:primary newer_than:7d',
      maxResults: '20',
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const threads = (gmailResult?.threads ?? []) as any[]
    if (threads.length === 0) {
      return NextResponse.json({ items: [], count: 0 })
    }

    // 2. Fetch metadata for each thread (max 8 — keep fast)
    const threadDetails = await Promise.all(
      threads.slice(0, 8).map(async (t: { id: string }) => {
        try {
          return await gmailGet(`/threads/${t.id}`, { format: 'full' })
        } catch {
          return null
        }
      })
    )

    // 3. Extract email data
    const emails: Array<{
      threadId: string
      from: string
      senderName: string
      senderEmail: string
      subject: string
      date: string
      body: string
    }> = []

    for (const thread of threadDetails) {
      if (!thread?.messages?.length) continue
      // Get the last message in the thread (most recent)
      const lastMsg = thread.messages[thread.messages.length - 1]
      const headers = lastMsg?.payload?.headers ?? []
      const from = getHeader(headers, 'From') ?? ''
      const subject = getHeader(headers, 'Subject') ?? '(no subject)'
      const dateStr = getHeader(headers, 'Date') ?? ''
      const body = extractBody(lastMsg?.payload) ?? ''

      // Skip if last message is from us
      if (from.includes('tonydurante.us')) continue

      const senderEmail = from.match(/<([^>]+)>/)?.[1] ?? from.split(' ').pop() ?? ''
      const senderName = from.replace(/<[^>]+>/, '').trim().replace(/"/g, '') || senderEmail

      emails.push({
        threadId: thread.id,
        from,
        senderName,
        senderEmail: senderEmail.toLowerCase(),
        subject,
        date: dateStr,
        body: body.slice(0, 800), // Limit body for AI context
      })
    }

    if (emails.length === 0) {
      return NextResponse.json({ items: [], count: 0 })
    }

    // 4. Look up all sender emails in CRM (batch)
    const senderEmails = emails.map(e => e.senderEmail).filter(Boolean)
    const { data: knownContacts } = await supabaseAdmin
      .from('contacts')
      .select('id, full_name, email, email_2, account_contacts(account_id)')
      .or(senderEmails.map(e => `email.eq.${e},email_2.eq.${e}`).join(','))

    // Build email→contact lookup
    const contactByEmail = new Map<string, { contactId: string; accountId?: string }>()
    for (const c of knownContacts ?? []) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const acJunction = c.account_contacts as any[]
      const accountId = acJunction?.[0]?.account_id
      if (c.email) contactByEmail.set(c.email.toLowerCase(), { contactId: c.id, accountId })
      if (c.email_2) contactByEmail.set(c.email_2.toLowerCase(), { contactId: c.id, accountId })
    }

    // Also check leads
    const { data: knownLeads } = await supabaseAdmin
      .from('leads')
      .select('id, email, status')
      .in('email', senderEmails)

    const leadByEmail = new Map<string, { leadId: string; status: string }>()
    for (const l of knownLeads ?? []) {
      if (l.email) leadByEmail.set(l.email.toLowerCase(), { leadId: l.id, status: l.status })
    }

    // 5. AI Classification — batch all emails in one call
    const emailSummaries = emails.map((e, i) => {
      const isKnown = contactByEmail.has(e.senderEmail) || leadByEmail.has(e.senderEmail)
      const leadInfo = leadByEmail.get(e.senderEmail)
      return `EMAIL ${i + 1}:
From: ${e.senderName} <${e.senderEmail}>${isKnown ? ' [EXISTING CRM CONTACT]' : ' [UNKNOWN]'}${leadInfo ? ` [LEAD: ${leadInfo.status}]` : ''}
Subject: ${e.subject}
Body: ${e.body.slice(0, 400)}`
    }).join('\n\n---\n\n')

    // Direct Anthropic call with 15s timeout (callAI has 5s — too short for batch)
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'AI not configured' }, { status: 503 })
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)

    let classificationText = ''
    try {
      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1500,
          system: `You are an email triage AI for Tony Durante LLC, a US business formation and tax consulting company.

CLASSIFY each email into one of these categories:
- new_lead: Someone asking about services (LLC formation, tax consulting, ITIN, etc.) who is NOT an existing client
- service_request: An existing client requesting a new service or add-on
- client_question: An existing client asking about their current service status, documents, etc.
- follow_up: A reply to an ongoing conversation that needs a response
- noise: Newsletters, marketing, automated notifications, spam — anything that does NOT need a human response

For each email, provide:
1. category (one of the 5 above)
2. summary (1 sentence — what they want)
3. suggested_action (1 sentence — what Antonio should do)
4. urgency: high (new lead or urgent client issue), medium (needs response within 24h), low (can wait)

RESPOND ONLY with a JSON array. No markdown, no explanation. Example:
[{"email_index":1,"category":"new_lead","summary":"Asking about LLC formation in Wyoming","suggested_action":"Schedule a call or send service offer","urgency":"high"}]`,
          messages: [{ role: 'user', content: emailSummaries }],
          temperature: 0.3,
        }),
        signal: controller.signal,
      })

      if (!aiRes.ok) {
        throw new Error(`Anthropic ${aiRes.status}`)
      }

      const aiData = await aiRes.json()
      classificationText = aiData.content?.[0]?.text?.trim() ?? ''
    } finally {
      clearTimeout(timeout)
    }

    if (!classificationText) {
      throw new Error('Empty AI response')
    }

    const classificationResult = { text: classificationText, provider: 'anthropic' as const }

    // 6. Parse AI response
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let classifications: any[] = []
    try {
      const jsonStr = classificationResult.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
      classifications = JSON.parse(jsonStr)
    } catch {
      // If AI returns invalid JSON, return raw emails without classification
      return NextResponse.json({
        items: emails.map(e => ({
          threadId: e.threadId,
          from: e.from,
          senderName: e.senderName,
          senderEmail: e.senderEmail,
          subject: e.subject,
          date: e.date,
          category: 'follow_up' as const,
          summary: e.subject,
          suggestedAction: 'Review and respond',
          urgency: 'amber' as const,
          isExistingContact: contactByEmail.has(e.senderEmail),
        })),
        count: emails.length,
        aiError: true,
      })
    }

    // 7. Merge AI classifications with email data
    const items: EmailIntelligenceItem[] = []

    for (const cls of classifications) {
      const idx = (cls.email_index ?? cls.emailIndex ?? 1) - 1
      const email = emails[idx]
      if (!email) continue

      // Skip noise
      if (cls.category === 'noise') continue

      const crmMatch = contactByEmail.get(email.senderEmail)
      const urgencyMap: Record<string, 'red' | 'amber' | 'green'> = {
        high: 'red',
        medium: 'amber',
        low: 'green',
      }

      items.push({
        threadId: email.threadId,
        from: email.from,
        senderName: email.senderName,
        senderEmail: email.senderEmail,
        subject: email.subject,
        date: email.date,
        category: cls.category,
        summary: cls.summary || email.subject,
        suggestedAction: cls.suggested_action || cls.suggestedAction || 'Review and respond',
        urgency: urgencyMap[cls.urgency] ?? 'amber',
        isExistingContact: !!crmMatch,
        contactId: crmMatch?.contactId,
        accountId: crmMatch?.accountId,
      })
    }

    // Sort: new_lead first, then service_request, then by urgency
    const categoryOrder: Record<string, number> = { new_lead: 0, service_request: 1, client_question: 2, follow_up: 3 }
    const urgencyOrder: Record<string, number> = { red: 0, amber: 1, green: 2 }
    items.sort((a, b) => {
      const catDiff = (categoryOrder[a.category] ?? 3) - (categoryOrder[b.category] ?? 3)
      if (catDiff !== 0) return catDiff
      return (urgencyOrder[a.urgency] ?? 1) - (urgencyOrder[b.urgency] ?? 1)
    })

    return NextResponse.json({ items, count: items.length, provider: classificationResult.provider })
  } catch (err: unknown) {
    console.error('[email-intelligence] Error:', err)
    return NextResponse.json({ error: 'Failed to analyze emails' }, { status: 500 })
  }
}
