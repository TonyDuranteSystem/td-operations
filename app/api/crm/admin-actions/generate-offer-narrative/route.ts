import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { canPerform } from '@/lib/permissions'
import { validateNarrative, renderCallForOffer, normalizeEntityType } from '@/lib/offer-narrative'
import {
  OFFER_NARRATIVE_RULES_TAG,
  FALLBACK_BUSINESS_RULES,
  renderServiceLines,
  resolveBusinessRules,
  buildSystemPrompt,
  buildUserPrompt,
  offerIncludesManagement,
  type NarrativeServiceInput,
} from '@/lib/offers/narrative-business-rules'
import { callAI } from '@/lib/portal/ai-provider'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { reportSystemError } from '@/lib/system-errors'

// A rich ~4096-token Sonnet narrative runs well past the default function
// window; give it room (proven value already used elsewhere in this codebase)
// so the request isn't killed mid-generation.
export const maxDuration = 300

/**
 * Fetch the most recent call's notes + full transcript for this lead/account
 * from call_summaries, rendered as a context block for the offer-narrative AI.
 * This is what turns a thin "summary" into a genuinely personalized narrative —
 * the model gets what the client actually said, not just the capped notes the
 * dialog pasted in. Best-effort: returns '' on no call / any error so the
 * generator cleanly falls back to notes-only.
 */
async function fetchCallContext(leadId?: string | null, accountId?: string | null): Promise<string> {
  if (!leadId && !accountId) return ''
  try {
    let query = supabaseAdmin
      .from('call_summaries')
      .select('meeting_name, created_at, notes, transcript')
      .order('created_at', { ascending: false })
      .limit(1)
    // Prefer the lead's call; fall back to the account's.
    query = leadId ? query.eq('lead_id', leadId) : query.eq('account_id', accountId as string)
    const { data, error } = await query.maybeSingle()
    if (error || !data) return ''
    return renderCallForOffer(data)
  } catch (err) {
    console.error('[generate-offer-narrative] call-context fetch failed (non-fatal):', err instanceof Error ? err.message : err)
    return ''
  }
}

/**
 * Load the editable offer-narrative BUSINESS RULES from the knowledge base (the
 * canonical business-rules store — Antonio edits them there, no code change). We
 * take the most-recently-updated article carrying the rules tag; `created_at` is
 * a deterministic tiebreaker (updated_at can be null). FAIL-SAFE: any miss/error
 * degrades to the built-in floor so the writer still never invents bookkeeping.
 *
 * LOUD ON MISS: a genuinely-absent/mistagged article is a CONFIG error (Antonio's
 * live edits would be silently ignored), so it is reported — distinctly from a
 * transient DB error. Never fail-open.
 */
async function loadBusinessRules(userEmail?: string | null): Promise<string> {
  try {
    const { data, error } = await supabaseAdmin
      .from('knowledge_articles')
      .select('content')
      .contains('tags', [OFFER_NARRATIVE_RULES_TAG])
      .order('updated_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    const { rules, source } = resolveBusinessRules(data)
    if (source === 'fallback_missing') {
      // Config error, not a blip: the editable rules article is missing/mistagged
      // so every offer silently uses the code floor and admin edits do nothing.
      console.error(`[generate-offer-narrative] no knowledge article tagged "${OFFER_NARRATIVE_RULES_TAG}" — using built-in fallback floor. Create/tag the article so edits take effect.`)
      await reportSystemError({
        source: 'server',
        route: '/api/crm/admin-actions/generate-offer-narrative',
        method: 'POST',
        http_status: 200,
        user_email: userEmail ?? null,
        message: `Offer-narrative rules article (tag "${OFFER_NARRATIVE_RULES_TAG}") not found — generator fell back to the built-in floor; admin KB edits have no effect until the article is created and tagged.`,
      }).catch(() => {})
    }
    return rules
  } catch (err) {
    // Transient DB error — quiet fallback, still safe (never fail-open).
    console.error('[generate-offer-narrative] business-rules load failed, using fallback floor:', err instanceof Error ? err.message : err)
    return FALLBACK_BUSINESS_RULES
  }
}

// ── Route handler ──

export async function POST(req: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!canPerform(user, 'create_offer')) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }

    const body = await req.json()
    const { client_name, language, services, notes_context, contract_type, entity_type, includes_management, lead_id, account_id } = body

    if (!client_name || !services || !Array.isArray(services) || services.length === 0) {
      return NextResponse.json(
        { error: 'client_name and services (non-empty array) are required' },
        { status: 400 },
      )
    }

    // Services arrive from the dialog as { name, description } read straight from
    // the editable services catalog (older/other callers may send bare names).
    // Render "Name — description" lines so the writer describes the REAL service,
    // not prose invented in code.
    const serviceLines = renderServiceLines(services as NarrativeServiceInput[])
    if (serviceLines.length === 0) {
      return NextResponse.json(
        { error: 'services must contain at least one named service' },
        { status: 400 },
      )
    }

    const lang: 'en' | 'it' = language === 'it' ? 'it' : 'en'
    // Whether this offer carries ongoing management — gates the management/portal
    // language so a narrow standalone offer (ITIN-only, notary-only) doesn't
    // promise registered agent / annual filing / the portal the client didn't buy.
    // The dialog sends an explicit flag computed from the real selected services;
    // fall back to deriving it from the contract type for other callers.
    const contractType = contract_type || 'formation'
    // Prefer the dialog's explicit flag (computed from the real selected
    // services). Fall back to the RAW contract type — not the 'formation'
    // default — so an absent/unknown type never silently defaults to management ON.
    const includesManagement = typeof includes_management === 'boolean'
      ? includes_management
      : offerIncludesManagement(contract_type)

    // Business rules (what TD does/doesn't do, tax filing by company type, portal)
    // come from the editable knowledge base, not hardcoded prose. Fail-safe.
    const businessRules = await loadBusinessRules(user?.email)
    const systemPrompt = buildSystemPrompt(lang, businessRules, includesManagement)

    // Enrich the context with the client's actual call (notes + full transcript)
    // so the narrative is grounded in what they really said, not just the capped
    // summary the dialog pasted in. Best-effort — empty when no call exists.
    const callContext = await fetchCallContext(lead_id, account_id)
    const combinedContext = [notes_context || '', callContext]
      .filter((s) => s && s.trim())
      .join('\n\n──────────\n\n')

    const userPrompt = buildUserPrompt(
      client_name,
      lang,
      serviceLines,
      combinedContext,
      contractType,
      normalizeEntityType(entity_type),
    )

    // AI generation via the shared provider (lib/portal/ai-provider.ts):
    // single source of truth for the model id (ANTHROPIC_MODELS.sonnet) PLUS
    // automatic Anthropic→OpenAI failover + timeout handling. Replaces the old
    // hardcoded fetch whose model string 404'd the day claude-sonnet-4-20250514
    // retired (2026-06-15) — with failover, a retired/broken model now degrades
    // to the fallback provider instead of erroring the offer dialog.
    let rawText: string
    try {
      const ai = await callAI({
        systemPrompt,
        userPrompt,
        maxTokens: 4096,
        temperature: 0.7,
        model: 'sonnet',
        // Large narrative generation is slow — the old 30s default silently
        // timed this out. 90s per attempt (Sonnet → Opus fallback) fits inside
        // the 300s maxDuration above.
        timeoutMs: 90_000,
      })
      rawText = ai.text
    } catch (err) {
      // Surface the real cause (admin-only route) instead of a generic message,
      // so a future failure is diagnosable from the toast (R099).
      const message = err instanceof Error ? err.message : 'AI generation failed'
      console.error('[generate-offer-narrative] AI generation failed:', message)
      await reportSystemError({
        source: 'server',
        route: '/api/crm/admin-actions/generate-offer-narrative',
        method: 'POST',
        http_status: 502,
        user_email: user?.email ?? null,
        message,
      })
      return NextResponse.json({ error: message }, { status: 502 })
    }

    if (!rawText) {
      return NextResponse.json({ error: 'AI returned empty response' }, { status: 502 })
    }

    // Parse JSON — strip markdown fences if present
    const jsonStr = rawText.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonStr)
    } catch {
      console.error('[generate-offer-narrative] Failed to parse AI response:', rawText.substring(0, 500))
      return NextResponse.json({ error: 'AI returned invalid JSON' }, { status: 502 })
    }

    // Validate structure (language-aware: only require the matching intro)
    const validation = validateNarrative(parsed, lang)
    if ('result' in validation) {
      return NextResponse.json({ success: true, narrative: validation.result })
    }
    const errMsg = 'error' in validation ? validation.error : 'Unknown validation error'
    console.error('[generate-offer-narrative] Validation failed:', errMsg)
    return NextResponse.json(
      { error: `AI response validation failed: ${errMsg}` },
      { status: 502 },
    )
  } catch (err) {
    console.error('[generate-offer-narrative] Error:', err)
    await reportSystemError({
      source: 'server',
      route: '/api/crm/admin-actions/generate-offer-narrative',
      method: 'POST',
      http_status: 500,
      message: err instanceof Error ? err.message : 'Internal server error',
    })
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    )
  }
}