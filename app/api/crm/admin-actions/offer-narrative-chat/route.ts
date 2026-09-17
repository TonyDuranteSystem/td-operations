import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { canPerform } from '@/lib/permissions'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { validateNarrative, validateNarrativeChanges, renderCallForOffer, normalizeEntityType } from '@/lib/offer-narrative'
import {
  renderServiceLines,
  buildSystemPrompt,
  buildUserPrompt,
  buildRefineSystemPrompt,
  buildRefineUserPrompt,
  offerIncludesManagement,
  canGroundFormationState,
  canGroundEntityType,
  extractJsonObject,
  reconstructAiNarrativeBaseline,
  detectOverwrittenHandEdits,
  type NarrativeServiceInput,
} from '@/lib/offers/narrative-business-rules'
import { loadOfferBusinessRules } from '@/lib/offers/load-business-rules'
import { getAllSellableServices } from '@/lib/services'
import { callAI } from '@/lib/portal/ai-provider'
import { reportSystemError } from '@/lib/system-errors'
import { resolveSubjectEmail, findRelevantEmailContext } from '@/lib/offers/narrative-email-context'
import {
  createConversation,
  loadConversation,
  appendTurnPair,
  touchConversation,
  toMessageHistory,
  type ConversationSubject,
} from '@/lib/offers/narrative-conversation'

/**
 * ONE conversational endpoint for the offer narrative — replaces the old
 * generate-offer-narrative / refine-offer-narrative pair (dev job —
 * offer-narrative chat redesign, 2026-09-16, council-reviewed).
 *
 * TURN 1 (no `instruction`, or `conversation_id` omitted): auto-fired by the
 * dialog's single "Generate with AI" click, exactly like the old generate
 * route — produces the FULL narrative. Starts a brand-new conversation every
 * time, even if a `conversation_id` was sent (a fresh generate always means
 * "start over", never "append a redundant regenerate instruction to the old
 * thread" — the server-side half of the dialog's regenerate-invalidates-the-
 * thread fix).
 *
 * TURN 2+ (`instruction` present + a real `conversation_id`): a real
 * conversational exchange — the model sees PRIOR turns as actual Anthropic
 * message history (lib/portal/ai-provider.ts's `history`) AND the FULL
 * current (possibly hand-edited) narrative state resent fresh this turn, per
 * the design requirement: memory augments grounding, it does not replace it,
 * because a stale AI turn must never silently overwrite a human's edit.
 * Output stays the same strict "only what changed" JSON contract the old
 * refine route used (validateNarrativeChanges) — never raw prose — so the
 * no-clobber guarantee holds for every turn, not just the first.
 *
 * SECURITY: `canPerform(user, 'create_offer')` gates the whole route, same as
 * both routes it replaces. The conversation's scope is re-derived from the
 * STORED row and re-checked against this request's claimed lead/account/
 * contact on every turn (lib/offers/narrative-conversation.ts::loadConversation)
 * — mirrors lib/ai-agent/client-scope.ts's "never trust a client-supplied id
 * blindly" discipline, adapted to this narrower, non-model-dispatched surface.
 * The only tools ever invoked (gmail_search / gmail_read_thread, via
 * findRelevantEmailContext) are CODE-decided, never model-chosen — this
 * route does not hand the model a tool schema and never routes through the
 * general worker/agent engine's decideAction()-then-dispatch surface. That
 * surface exists for a DIFFERENT job (flexible, model-chosen tool calls with
 * an approval rail); wiring this bounded, read-only, two-tool helper into it
 * would not add safety here — it would subject a call that must always
 * resolve silently to an approval gate that is OFF by default (R108/R111),
 * which is a regression dressed as hardening. See docs/systems/offers.md's
 * 2026-08-28e entry for the incident (an ungated predecessor sending an
 * email with no approval) that this boundary exists to prevent — this
 * surface still cannot reach a send/write/mutate tool, at any turn.
 */

// Large-output Sonnet generation + the optional email lookup (classify +
// search + read-thread) can each take real time; matches the larger of the
// two routes this replaces.
export const maxDuration = 300

interface CurrentNarrativeBody {
  intro_en?: string
  intro_it?: string
  strategy?: string
  next_steps?: string
  future_developments?: string
  immediate_actions?: string
}

/**
 * Fetch the most recent call's notes + full transcript for this lead/account,
 * rendered as context for the FIRST turn. Best-effort: '' on no call / any
 * error, so the writer falls back to notes-only. Ported verbatim from the
 * old generate-offer-narrative route.
 */
async function fetchCallContext(leadId?: string | null, accountId?: string | null): Promise<string> {
  if (!leadId && !accountId) return ''
  try {
    let query = supabaseAdmin
      .from('call_summaries')
      .select('meeting_name, created_at, notes, transcript')
      .order('created_at', { ascending: false })
      .limit(1)
    query = leadId ? query.eq('lead_id', leadId) : query.eq('account_id', accountId as string)
    const { data, error } = await query.maybeSingle()
    if (error || !data) return ''
    return renderCallForOffer(data)
  } catch (err) {
    console.error('[offer-narrative-chat] call-context fetch failed (non-fatal):', err instanceof Error ? err.message : err)
    return ''
  }
}

/** Full sellable-service menu, for the refine model's reference (never claim TD
 * doesn't offer something it does). Best-effort: '' on any error. */
async function loadServiceMenu(): Promise<string> {
  try {
    const rows = await getAllSellableServices()
    return rows
      .map((r) => {
        const name = r.display_name || r.slug
        const desc = (r.description || '').trim()
        return desc ? `- ${name}: ${desc}` : `- ${name}`
      })
      .join('\n')
  } catch (err) {
    console.error('[offer-narrative-chat] service-menu load failed (non-fatal):', err instanceof Error ? err.message : err)
    return ''
  }
}

function deriveIncludesManagement(includesManagementBody: unknown, contractType: string): boolean {
  return typeof includesManagementBody === 'boolean' ? includesManagementBody : offerIncludesManagement(contractType)
}

export async function POST(req: NextRequest) {
  let userEmailForError: string | null = null
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!canPerform(user, 'create_offer')) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }
    userEmailForError = user?.email ?? null

    const body = await req.json()
    const {
      conversation_id, lead_id, account_id, contact_id,
      client_name, language, services, notes_context,
      contract_type, entity_type, formation_state,
      includes_management, has_multiple_options,
      current, instruction, stale_grounding_note,
    } = body

    if (!client_name || !services || !Array.isArray(services) || services.length === 0) {
      return NextResponse.json({ error: 'client_name and services (non-empty array) are required' }, { status: 400 })
    }
    const serviceLines = renderServiceLines(services as NarrativeServiceInput[])
    if (serviceLines.length === 0) {
      return NextResponse.json({ error: 'services must contain at least one named service' }, { status: 400 })
    }

    const subject: ConversationSubject = {
      leadId: typeof lead_id === 'string' && lead_id ? lead_id : null,
      accountId: typeof account_id === 'string' && account_id ? account_id : null,
      contactId: typeof contact_id === 'string' && contact_id ? contact_id : null,
    }
    if (!subject.leadId && !subject.accountId && !subject.contactId) {
      return NextResponse.json(
        { error: 'At least one of lead_id, account_id, or contact_id is required to start a narrative conversation' },
        { status: 400 },
      )
    }

    const lang: 'en' | 'it' = language === 'it' ? 'it' : 'en'
    const contractType = contract_type || 'formation'
    const hasMultipleOptions = has_multiple_options === true
    const includesManagement = deriveIncludesManagement(includes_management, contract_type)

    // GROUNDING GATES — re-derived server-side on EVERY turn, never trusted
    // from the dialog alone (dev_task 2b6e5988 + the bug-hunter's contract-type
    // blocker; see lib/offers/narrative-business-rules.ts). A caller that sends
    // a formation_state/entity_type this turn's contract type / option count
    // doesn't support gets it silently dropped, not silently believed.
    const groundedFormationState = canGroundFormationState({ contractType, hasMultipleOptions })
      ? (typeof formation_state === 'string' && formation_state.trim() ? formation_state.trim() : '')
      : ''
    const groundedEntityType = canGroundEntityType({ hasMultipleOptions })
      ? normalizeEntityType(entity_type)
      : ''

    const businessRules = await loadOfferBusinessRules({ route: '/api/crm/admin-actions/offer-narrative-chat', userEmail: user?.email })

    const instructionText = typeof instruction === 'string' ? instruction.trim() : ''
    const isFirstTurn = !instructionText

    if (isFirstTurn) {
      return await handleFirstTurn({
        subject, createdBy: user?.email ?? null,
        clientName: client_name, lang, serviceLines, notesContext: notes_context,
        contractType, entityType: groundedEntityType, formationState: groundedFormationState,
        includesManagement, hasMultipleOptions, businessRules,
        leadId: subject.leadId, accountId: subject.accountId,
      })
    }

    if (!conversation_id || typeof conversation_id !== 'string') {
      return NextResponse.json(
        { error: 'A conversation_id is required to continue the discussion — generate a narrative first.' },
        { status: 400 },
      )
    }
    if (!current || typeof current !== 'object') {
      return NextResponse.json({ error: 'current narrative is required' }, { status: 400 })
    }

    return await handleFollowUpTurn({
      conversationId: conversation_id, subject,
      clientName: client_name, lang, serviceLines,
      contractType, entityType: groundedEntityType, formationState: groundedFormationState,
      businessRules, current: current as CurrentNarrativeBody,
      instruction: instructionText,
      staleGroundingNote: typeof stale_grounding_note === 'string' ? stale_grounding_note : undefined,
      leadId: subject.leadId, accountId: subject.accountId, contactId: subject.contactId,
    })
  } catch (err) {
    console.error('[offer-narrative-chat] Error:', err)
    await reportSystemError({
      source: 'server', route: '/api/crm/admin-actions/offer-narrative-chat', method: 'POST',
      http_status: 500, user_email: userEmailForError, message: err instanceof Error ? err.message : 'Internal server error',
    }).catch(() => {})
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal server error' }, { status: 500 })
  }
}

async function handleFirstTurn(opts: {
  subject: ConversationSubject
  createdBy: string | null
  clientName: string
  lang: 'en' | 'it'
  serviceLines: string[]
  notesContext?: string
  contractType: string
  entityType: string
  formationState: string
  includesManagement: boolean
  hasMultipleOptions: boolean
  businessRules: string
  leadId: string | null
  accountId: string | null
}): Promise<NextResponse> {
  const systemPrompt = buildSystemPrompt(opts.lang, opts.businessRules, opts.includesManagement, opts.hasMultipleOptions)
  const callContext = await fetchCallContext(opts.leadId, opts.accountId)
  const combinedContext = [opts.notesContext || '', callContext].filter((s) => s && s.trim()).join('\n\n──────────\n\n')
  const userPrompt = buildUserPrompt(
    opts.clientName, opts.lang, opts.serviceLines, combinedContext,
    opts.contractType, opts.entityType, opts.formationState,
  )

  let rawText: string
  try {
    const ai = await callAI({ systemPrompt, userPrompt, maxTokens: 4096, temperature: 0.7, model: 'sonnet', timeoutMs: 90_000 })
    rawText = ai.text
  } catch (err) {
    const message = err instanceof Error ? err.message : 'AI generation failed'
    console.error('[offer-narrative-chat] generation failed:', message)
    await reportSystemError({
      source: 'server', route: '/api/crm/admin-actions/offer-narrative-chat', method: 'POST',
      http_status: 502, message,
    }).catch(() => {})
    return NextResponse.json({ error: message }, { status: 502 })
  }
  if (!rawText) return NextResponse.json({ error: 'AI returned empty response' }, { status: 502 })

  const jsonStr = extractJsonObject(rawText)
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    console.error('[offer-narrative-chat] failed to parse AI response:', rawText.substring(0, 500))
    return NextResponse.json({ error: "Couldn't generate the narrative — try again, or rephrase what you're asking for." }, { status: 502 })
  }
  const validation = validateNarrative(parsed, opts.lang)
  if ('error' in validation) {
    console.error('[offer-narrative-chat] validation failed:', validation.error)
    return NextResponse.json({ error: `AI response validation failed: ${validation.error}` }, { status: 502 })
  }

  // Persist AFTER a valid result — a conversation that never got a usable
  // first turn isn't worth continuing, and nothing downstream depends on it
  // existing before this point.
  let conversationId: string
  try {
    conversationId = await createConversation(opts.subject, opts.createdBy)
    await appendTurnPair(conversationId, userPrompt, rawText)
  } catch (err) {
    // The narrative itself is good — persistence failing must not throw it
    // away, only cost the conversation memory for later turns. Surfaced
    // loudly so it's diagnosable, but the response still succeeds.
    console.error('[offer-narrative-chat] conversation persistence failed (narrative still returned):', err instanceof Error ? err.message : err)
    await reportSystemError({
      source: 'server', route: '/api/crm/admin-actions/offer-narrative-chat', method: 'POST',
      http_status: 200, message: `Narrative conversation persistence failed: ${err instanceof Error ? err.message : String(err)}`,
    }).catch(() => {})
    return NextResponse.json({ success: true, conversation_id: null, turn: 'generate', narrative: validation.result })
  }

  return NextResponse.json({ success: true, conversation_id: conversationId, turn: 'generate', narrative: validation.result })
}

async function handleFollowUpTurn(opts: {
  conversationId: string
  subject: ConversationSubject
  clientName: string
  lang: 'en' | 'it'
  serviceLines: string[]
  contractType: string
  entityType: string
  formationState: string
  businessRules: string
  current: CurrentNarrativeBody
  instruction: string
  staleGroundingNote?: string
  leadId: string | null
  accountId: string | null
  contactId: string | null
}): Promise<NextResponse> {
  const loaded = await loadConversation(opts.conversationId, opts.subject)
  if ('error' in loaded) {
    // Scope mismatch / not-found — refuse, don't silently start over (that
    // would discard a conversational instruction the model never saw the
    // context for). The dialog surfaces this and lets the staffer regenerate.
    return NextResponse.json({ error: loaded.error }, { status: 409 })
  }

  const [serviceMenu, subjectEmail] = await Promise.all([loadServiceMenu(), resolveSubjectEmail({
    contactId: opts.contactId, leadId: opts.leadId, accountId: opts.accountId,
  })])
  const emailContext = await findRelevantEmailContext(opts.instruction, subjectEmail)

  const systemPrompt = buildRefineSystemPrompt(opts.lang, opts.businessRules, serviceMenu)
  const userPrompt = buildRefineUserPrompt({
    clientName: opts.clientName,
    contractType: opts.contractType,
    entityType: opts.entityType,
    formationState: opts.formationState,
    serviceLines: opts.serviceLines,
    current: opts.current,
    instruction: opts.instruction,
    emailContext,
    staleGroundingNote: opts.staleGroundingNote,
  })
  const history = toMessageHistory(loaded.turns)

  let rawText: string
  try {
    // temperature 0: a refine turn must be a precise, minimal edit, not a
    // creative regeneration that reshapes untouched sections.
    const ai = await callAI({ systemPrompt, userPrompt, maxTokens: 2048, temperature: 0, model: 'sonnet', timeoutMs: 90_000, history })
    rawText = ai.text
  } catch (err) {
    const message = err instanceof Error ? err.message : 'AI refine failed'
    console.error('[offer-narrative-chat] refine failed:', message)
    await reportSystemError({
      source: 'server', route: '/api/crm/admin-actions/offer-narrative-chat', method: 'POST',
      http_status: 502, message,
    }).catch(() => {})
    return NextResponse.json({ error: message }, { status: 502 })
  }
  if (!rawText) return NextResponse.json({ error: 'AI returned empty response' }, { status: 502 })

  const jsonStr = extractJsonObject(rawText)
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    console.error('[offer-narrative-chat] failed to parse AI response:', rawText.substring(0, 500))
    return NextResponse.json({ error: "Couldn't apply that change — it may conflict with one of the writing rules (e.g. only one language gets filled in at a time). Try rephrasing." }, { status: 502 })
  }
  const validation = validateNarrativeChanges(parsed, opts.lang)
  if ('error' in validation) {
    console.error('[offer-narrative-chat] validation failed:', validation.error)
    return NextResponse.json({ error: `AI response validation failed: ${validation.error}` }, { status: 502 })
  }

  // Hand-edit-loss warning (dev job 9d7ad3f1, Antonio's option 1 from the
  // 2026-09-16 stress test): flag it, don't block it. `loaded.turns` is the
  // history BEFORE this turn, so the reconstructed baseline is exactly "what
  // the AI last set each field to" — compared against `opts.current`, the
  // on-screen value at the moment this turn was sent, for only the fields
  // this turn is actually about to overwrite.
  const aiBaseline = reconstructAiNarrativeBaseline(loaded.turns)
  const overwrittenHandEdits = detectOverwrittenHandEdits(
    opts.current as unknown as Record<string, string | undefined | null>,
    aiBaseline,
    validation.changes as unknown as Record<string, unknown>,
  )

  // Persist the exchange AFTER validation succeeds — an invalid/unusable turn
  // never becomes "memory" the next turn is forced to build on. appendTurnPair
  // writes both sides of the exchange in ONE atomic insert, so a failure here
  // leaves the conversation exactly as it was before this turn (never a
  // dangling user turn with no reply — see appendTurnPair's own header for why
  // that specific half-written state would break the NEXT turn's Anthropic
  // call). Safe to still return this turn's result: the client keeps the same
  // conversation_id, and the only real cost of a failure here is that this one
  // exchange isn't remembered — not corruption.
  try {
    await appendTurnPair(opts.conversationId, userPrompt, rawText)
    await touchConversation(opts.conversationId)
  } catch (err) {
    console.error('[offer-narrative-chat] follow-up persistence failed (changes still returned):', err instanceof Error ? err.message : err)
    await reportSystemError({
      source: 'server', route: '/api/crm/admin-actions/offer-narrative-chat', method: 'POST',
      http_status: 200, message: `Narrative conversation turn persistence failed: ${err instanceof Error ? err.message : String(err)}`,
    }).catch(() => {})
  }

  return NextResponse.json({
    success: true, conversation_id: opts.conversationId, turn: 'refine',
    note: validation.note, changes: validation.changes,
    overwritten_hand_edits: overwrittenHandEdits,
  })
}
