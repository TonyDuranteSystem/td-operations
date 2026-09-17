import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { checkRateLimit, getRateLimitKey } from '@/lib/portal/rate-limit'
import { callWorkerWithAttachments } from '@/lib/ai-agent/attachment-reader'
import { toWhatsAppJid } from '@/lib/messaging/phone'
import { NextRequest, NextResponse } from 'next/server'

export const maxDuration = 300

/**
 * POST /api/inbox/whatsapp-new/suggest
 *
 * AI-drafted WhatsApp reply for a LEAD or CONTACT — deliberately NOT a reuse
 * of /api/portal/chat/suggest, which is built entirely around an existing
 * client's account/services/deadlines/payments and portal_messages history.
 * None of that exists for a fresh lead, so this route has its own, thinner
 * context: the lead/contact record itself, plus whatever WhatsApp
 * conversation exists so far (messages/messaging_groups, not portal_messages).
 *
 * Deliberately does NOT load the approved-response template library
 * (lib/ai-agent/templates.ts) — those templates assume an existing, paying
 * client relationship (banking review, EIN status, filing deadlines) and
 * would risk grounding a cold-lead draft in language that doesn't apply yet
 * (Senior Engineer finding, dev job f331cd43).
 *
 * Body: { leadId?, contactId?, phone }. Exactly one of leadId/contactId.
 */
export async function POST(request: NextRequest) {
  const rl = checkRateLimit(getRateLimitKey(request) + ':whatsapp-suggest', 6, 60_000)
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

  const { leadId, contactId, phone } = await request.json() as {
    leadId?: string
    contactId?: string
    phone?: string
  }
  if (!leadId && !contactId) {
    return NextResponse.json({ error: 'leadId or contactId required' }, { status: 400 })
  }
  if (!phone) {
    return NextResponse.json({ error: 'phone required' }, { status: 400 })
  }

  try {
    // 1. Load the (thin) lead/contact record this draft is for.
    let name: string | null = null
    let sourceNote = ''
    if (leadId) {
      const { data: lead } = await supabaseAdmin
        .from('leads')
        .select('full_name, referrer_name')
        .eq('id', leadId)
        .single()
      name = lead?.full_name ?? null
      sourceNote = lead?.referrer_name ? `Referred by: ${lead.referrer_name}` : ''
    } else if (contactId) {
      const { data: contact } = await supabaseAdmin
        .from('contacts')
        .select('full_name, language')
        .eq('id', contactId)
        .single()
      name = contact?.full_name ?? null
      sourceNote = contact?.language ? `Preferred language: ${contact.language}` : ''
    }

    // 2. Load whatever WhatsApp conversation exists so far for this number,
    // on the active WhatsApp channel — read-only, does not create a group.
    const jid = toWhatsAppJid(phone)
    let conversationText = '(No previous WhatsApp messages with this number.)'
    const { data: group } = await supabaseAdmin
      .from('messaging_groups')
      .select('id')
      .eq('external_group_id', jid)
      .limit(1)
      .maybeSingle()

    if (group?.id) {
      const { data: history } = await supabaseAdmin
        .from('messages')
        .select('direction, content_text, content_type, created_at')
        .eq('group_id', group.id)
        .order('created_at', { ascending: false })
        .limit(20)
      const ordered = (history ?? []).reverse()
      if (ordered.length > 0) {
        conversationText = ordered
          .map((m) => `${m.direction === 'outbound' ? 'Antonio' : 'Lead/Contact'}: ${m.content_text ?? `[${m.content_type}]`}`)
          .join('\n')
      }
    }

    // 3. Draft via the shared AI-worker primitive, NOT the portal-chat prompt
    // or template library (see file header) — a lead-appropriate system
    // prompt only.
    const systemPromptOverride =
      "You are drafting a WhatsApp reply for Antonio, owner of a US company-formation/tax firm, to a PRE-SALE lead or prospect (not yet a paying client) — or an existing client he's sending an occasional WhatsApp message to. This is a casual, first-contact-appropriate channel, not a formal client support channel. Be warm, direct, brief (WhatsApp message length, not an email). Never invent services, prices, or timelines TD doesn't actually offer — if the lead asks something you don't have grounded information for, draft a reply that offers to follow up rather than guessing. Draft in the same language the lead/contact has been writing in. Output ONLY the message text itself, exactly as it should be sent — no preamble like 'here is a draft', no framing, no quotation marks around it, no explanation."

    const userMessage = `LEAD/CONTACT: ${name ?? 'Unknown name'} (${phone})${sourceNote ? `\n${sourceNote}` : ''}\n\nCONVERSATION SO FAR:\n${conversationText}\n\nDraft Antonio's next WhatsApp message:`

    const { reply } = await callWorkerWithAttachments(userMessage, {
      systemPromptOverride,
      enableDocReads: false,
      maxIterations: 3,
    })

    return NextResponse.json({ suggestion: reply, provider: 'anthropic' })
  } catch (err: unknown) {
    console.error('[whatsapp-new/suggest] Error:', err)
    return NextResponse.json({ error: 'Failed to generate suggestion' }, { status: 500 })
  }
}
