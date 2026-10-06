import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { checkRateLimit } from '@/lib/portal/rate-limit'
import { callAI } from '@/lib/portal/ai-provider'
import { fetchKBContext, buildKBQuery } from '@/lib/portal/kb-context'
import { gmailGet, extractBody, getHeader, isOwnMailboxAddress } from '@/lib/gmail'
import { checkMailboxAccess } from '@/lib/inbox/mailbox-access'
import {
  parseAiMode,
  POLISH_MAX_DRAFT_CHARS,
  POLISH_SYSTEM_PROMPT,
  buildPolishUserPrompt,
  polishMaxTokens,
  validatePolishResult,
  sanitizeSenderEmail,
  buildDraftClientContext,
  buildDraftSystemPrompt,
  cleanDraftOutput,
} from '@/lib/inbox/ai-email'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
// callAI can run two ~30s attempts (Sonnet, then Opus) after the Gmail + CRM reads; without this a long call
// was killed by the platform and the client got an HTML 504 it could not read.
export const maxDuration = 60

/**
 * POST /api/inbox/ai-suggest — the Inbox reply composer's one AI button.
 *
 * Body: { mode: 'polish' | 'draft', threadId?, mailbox?, messageId?, draft? }
 *
 *  • mode 'polish' — Antonio typed something. ONLY `draft` goes to the model: no thread, no CRM, no
 *    knowledge base, nothing to invent from (the 2026-10-06 incident: a short courtesy note came back as an
 *    email promising a private office and pricing). The result is checked by validatePolishResult before it
 *    is returned; a result that fails the checks is a 422 and his text is left alone.
 *  • mode 'draft'  — the box is empty. A first draft from the thread, with a reduced context (no EIN, no
 *    payments) and a rule never to state a price/amount/promise that is not in the thread.
 *
 * Every response is JSON; errors carry a plain-language `error` the composer shows as-is (R099).
 * See lib/inbox/ai-email.ts for the rules and docs/systems/inbox.md for the history.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }

  // Per STAFF MEMBER, not per IP: the whole office shares one IP, and the old 6/min-per-IP bucket was
  // shared by everyone and (via the composer's silent catch) failed invisibly.
  const rl = checkRateLimit(`inbox-ai:${user.id}`, 12, 60_000)
  if (!rl.allowed) {
    const wait = rl.retryAfter ?? 10
    return NextResponse.json(
      { error: `You're going a bit fast — please wait ${wait} seconds and try again.`, code: 'rate_limited', retryAfter: wait },
      { status: 429, headers: { 'Retry-After': String(wait) } }
    )
  }

  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: 'AI is not configured on this server.' }, { status: 503 })
  }

  try {
    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
    }

    const mode = parseAiMode(body.mode)
    if (!mode) {
      return NextResponse.json({ error: 'Unknown AI mode.' }, { status: 400 })
    }

    // The mailbox the thread lives in. The old client never sent it, so a thread open in Antonio's own mailbox
    // was looked up in support@ — and the failure was swallowed. Validated and access-checked like every other
    // /api/inbox route that takes a mailbox (antonio@ is admin-only).
    const mailbox = body.mailbox === 'antonio' ? 'antonio' : body.mailbox === undefined || body.mailbox === 'support' ? 'support' : null
    if (!mailbox) {
      return NextResponse.json({ error: 'Unknown mailbox.' }, { status: 400 })
    }
    if (!(await checkMailboxAccess(mailbox))) {
      return NextResponse.json({ error: 'Not authorized for this mailbox' }, { status: 403 })
    }

    // ───────────────────────── POLISH ─────────────────────────
    if (mode === 'polish') {
      const draft = typeof body.draft === 'string' ? body.draft : ''
      if (!draft.trim()) {
        return NextResponse.json({ error: 'Type something first — there is nothing to polish.' }, { status: 400 })
      }
      if (draft.length > POLISH_MAX_DRAFT_CHARS) {
        return NextResponse.json(
          { error: `This text is too long to polish in one go (${draft.length.toLocaleString()} characters; the limit is ${POLISH_MAX_DRAFT_CHARS.toLocaleString()}). Polish it in parts.`, code: 'too_long' },
          { status: 400 }
        )
      }

      // NOTE: temperature is only honoured on the Sonnet attempt — callAI drops it on the Opus fallback
      // (lib/portal/ai-provider.ts). The validator below, not the temperature, is the safety gate.
      const result = await callAI({
        systemPrompt: POLISH_SYSTEM_PROMPT,
        userPrompt: buildPolishUserPrompt(draft),
        maxTokens: polishMaxTokens(draft),
        temperature: 0.2,
      })

      const checked = validatePolishResult(draft, result.text)
      if ('code' in checked) {
        return NextResponse.json({ error: checked.message, code: `rejected_${checked.code}` }, { status: 422 })
      }
      return NextResponse.json({ mode, result: checked.text, changed: checked.changed, provider: result.provider })
    }

    // ───────────────────────── DRAFT ─────────────────────────
    const threadId = typeof body.threadId === 'string' ? body.threadId : ''
    if (!threadId) {
      return NextResponse.json({ error: 'threadId required' }, { status: 400 })
    }
    const targetMessageId = typeof body.messageId === 'string' ? body.messageId : undefined

    const asUser = mailbox === 'antonio' ? 'antonio.durante@tonydurante.us' : 'support@tonydurante.us'

    // 1. The Gmail thread
    let thread
    try {
      thread = await gmailGet(`/threads/${threadId}`, { format: 'full' }, asUser)
    } catch (err) {
      console.error('[inbox/ai-suggest] Gmail read failed:', err)
      return NextResponse.json({ error: `Could not read this email thread from the ${mailbox}@ mailbox.` }, { status: 502 })
    }
    if (!thread?.messages?.length) {
      return NextResponse.json({ error: `This thread was not found in the ${mailbox}@ mailbox.` }, { status: 404 })
    }

    // 2. The conversation
    const messages = thread.messages.map((msg: Record<string, unknown>) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const payload = msg.payload as any
      const headers = payload?.headers ?? []
      const from = getHeader(headers, 'From') ?? ''
      const bodyText = extractBody(payload) ?? ''
      const isAdmin = isOwnMailboxAddress(from)
      return { id: msg.id as string, from, body: bodyText.slice(0, 1000), isAdmin }
    })

    // Same "which message" resolution as Reply/Draft (lib/inbox/reply-target.ts, duplicated here since this
    // route already has the thread in hand): an explicit pick from the client, else the newest message NOT
    // sent by us, else — nothing else sent us anything yet — the literal newest.
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
    // The sender comes from an email header — attacker-controlled. Only a strictly valid single address is
    // ever allowed into the database filter below (it used to be interpolated raw).
    const senderEmail = sanitizeSenderEmail(targetMessage?.from)
    const subject = getHeader(thread.messages[0]?.payload?.headers ?? [], 'Subject') ?? ''

    // 3. CRM context — company, services, deadlines ONLY (no EIN, no payments: see buildDraftClientContext).
    let account: { company_name: string | null; entity_type: string | null; state_of_formation: string | null } | null = null
    let services: Array<{ service_name: string | null; service_type: string | null; status: string | null }> | null = null
    let deadlines: Array<{ deadline_type: string | null; due_date: string | null; status: string | null }> | null = null

    if (senderEmail) {
      const { data: contact } = await supabaseAdmin
        .from('contacts')
        .select('id, full_name, email, account_contacts(account_id)')
        .or(`email.eq.${senderEmail},email_2.eq.${senderEmail}`)
        .limit(1)
        .maybeSingle()

      if (contact) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const accountIds = ((contact.account_contacts as any[]) ?? []).map((a) => a.account_id).filter(Boolean)
        // A person linked to several companies is ambiguous — guessing the first one put the WRONG company's
        // facts into a reply. With more than one, the draft simply gets no company context.
        const accountId = accountIds.length === 1 ? accountIds[0] : null

        if (accountId) {
          const [acctResult, svcResult, dlResult] = await Promise.all([
            supabaseAdmin
              .from('accounts')
              .select('company_name, entity_type, state_of_formation')
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
          ])
          account = acctResult.data
          services = svcResult.data
          deadlines = dlResult.data
        }
      }
    }

    // 4. Knowledge-base context (approved responses / rules)
    const kbQuery = buildKBQuery(
      targetMessage?.body?.slice(0, 100) ?? subject,
      services?.map(s => s.service_type).filter(Boolean) as string[] ?? []
    )
    const kbContext = await fetchKBContext(kbQuery)

    const clientContext = buildDraftClientContext(
      account ? { ...account, services, deadlines } : null
    )

    // The target message is marked explicitly rather than relying on "the latest one" — it may not be, when
    // staff (or the frozen default) targeted an earlier message in the thread.
    const threadText = messages
      .map((m: { isAdmin: boolean; body: string }, i: number) =>
        `${m.isAdmin ? 'Antonio' : 'Client'}${i === resolvedIndex ? ' [THIS IS THE MESSAGE TO REPLY TO]' : ''}: ${m.body}`
      )
      .join('\n---\n')

    const result = await callAI({
      systemPrompt: buildDraftSystemPrompt({ subject, clientContext, kbContext }),
      userPrompt: `Email thread:\n\n${threadText}\n\nDraft Antonio's reply to the message marked [THIS IS THE MESSAGE TO REPLY TO] above:`,
      maxTokens: 800,
      temperature: 0.4,
    })

    const draftText = cleanDraftOutput(result.text)
    if (!draftText) {
      return NextResponse.json({ error: 'The AI returned nothing — please try again.', code: 'empty' }, { status: 422 })
    }
    return NextResponse.json({ mode, result: draftText, provider: result.provider })
  } catch (err: unknown) {
    console.error('[inbox/ai-suggest] Error:', err)
    return NextResponse.json({ error: 'The AI is unavailable right now — please try again in a moment.' }, { status: 500 })
  }
}
