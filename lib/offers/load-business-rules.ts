/**
 * Shared server loader for the editable offer-narrative BUSINESS RULES.
 *
 * Both the generator and the refine step must read the SAME rules from the SAME
 * place, or a refined offer could drift from a freshly-generated one. This is the
 * single server-side load path: the most-recently-updated knowledge-base article
 * tagged `OFFER_NARRATIVE_RULES_TAG`, with `created_at` as a deterministic
 * tiebreaker (updated_at can be null).
 *
 * FAIL-SAFE, never fail-open: any miss/error degrades to the minimal floor so the
 * writer still never invents bookkeeping. A genuinely-missing/mistagged article
 * is a CONFIG error (admin edits silently ignored) and is reported LOUDLY — a
 * transient DB error falls back quietly.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { reportSystemError } from '@/lib/system-errors'
import { OFFER_NARRATIVE_RULES_TAG, FALLBACK_BUSINESS_RULES, resolveBusinessRules } from '@/lib/offers/narrative-business-rules'

export async function loadOfferBusinessRules(opts?: {
  route?: string
  userEmail?: string | null
}): Promise<string> {
  const route = opts?.route ?? '/api/crm/admin-actions/offer-narrative'
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
      console.error(`[offer-narrative] no knowledge article tagged "${OFFER_NARRATIVE_RULES_TAG}" — using built-in fallback floor. Create/tag the article so edits take effect.`)
      await reportSystemError({
        source: 'server',
        route,
        method: 'POST',
        http_status: 200,
        user_email: opts?.userEmail ?? null,
        message: `Offer-narrative rules article (tag "${OFFER_NARRATIVE_RULES_TAG}") not found — writer fell back to the built-in floor; admin KB edits have no effect until the article is created and tagged.`,
      }).catch(() => {})
    }
    return rules
  } catch (err) {
    console.error('[offer-narrative] business-rules load failed, using fallback floor:', err instanceof Error ? err.message : err)
    return FALLBACK_BUSINESS_RULES
  }
}
