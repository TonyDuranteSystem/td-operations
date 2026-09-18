import { supabaseAdmin } from '@/lib/supabase-admin'
import { callAI } from '@/lib/portal/ai-provider'
import { renderCallForOffer } from '@/lib/offer-narrative'

/**
 * Fetch the most recent call's notes + full transcript for this lead/account,
 * rendered as context for the offer-narrative AI. Best-effort: '' on no call
 * / any error, so the caller falls back to whatever context it already had.
 * Shared by the FIRST turn (offer-narrative-chat/route.ts::handleFirstTurn,
 * unconditional — always grounds the initial generate) and, since 2026-09-16,
 * every turn AFTER the first via {@link findRelevantCallContext} below,
 * conditional on the instruction actually asking for it.
 */
export async function fetchCallContext(leadId?: string | null, accountId?: string | null): Promise<string> {
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
    console.error('[narrative-call-context] call-context fetch failed (non-fatal):', err instanceof Error ? err.message : err)
    return ''
  }
}

/**
 * Read-only call-transcript lookup for a conversational turn on the
 * offer-narrative chat — the counterpart to {@link findRelevantEmailContext}
 * (lib/offers/narrative-email-context.ts), same shape, same reason: the
 * FIRST turn already reads the call transcript automatically
 * (fetchCallContext, above, called unconditionally by handleFirstTurn), but
 * a follow-up conversational turn had no way to re-check it even when
 * explicitly asked — Antonio, live, 2026-09-16: "if I tell you to read a
 * transcript, you read it." Fixed the same way the email gap was fixed:
 * a cheap classification call decides whether THIS instruction actually
 * needs the transcript at all, so an ordinary "shorten the intro" doesn't
 * pay for a lookup it doesn't need; only then does CODE fetch it — the
 * model is never given a tool schema on this surface, at any turn (see the
 * route's own header comment for the full security boundary this preserves).
 *
 * Deliberately reuses `fetchCallContext`'s existing "most recent call for
 * this lead/account" behavior rather than adding call-selection logic no one
 * asked for — the same call the first turn already grounded on.
 */
export async function findRelevantCallContext(
  instruction: string,
  leadId: string | null | undefined,
  accountId: string | null | undefined,
): Promise<string | undefined> {
  if (!leadId && !accountId) return undefined
  try {
    const classify = await callAI({
      systemPrompt:
        'Decide whether answering the instruction requires checking what was actually said on the client\'s intake call (the call notes or transcript already on file) — e.g. "read the transcript", "check what he said about X", "re-read the call". Reply with ONLY a JSON object: {"needs_call": true|false}. Only set needs_call true when the instruction refers to something said or discussed on a call, or explicitly asks you to check/verify against it, that is not already given as plain context.',
      userPrompt: instruction,
      maxTokens: 100,
      temperature: 0,
      model: 'sonnet',
      timeoutMs: 20_000,
    })
    const jsonStr = classify.text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
    const decision = JSON.parse(jsonStr) as { needs_call?: boolean }
    if (!decision.needs_call) return undefined

    const rendered = await fetchCallContext(leadId, accountId)
    return rendered || undefined
  } catch (err) {
    console.error('[narrative-call-context] call lookup failed (non-fatal):', err instanceof Error ? err.message : err)
    return undefined
  }
}
