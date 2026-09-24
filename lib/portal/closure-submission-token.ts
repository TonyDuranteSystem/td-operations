import { supabaseAdmin } from "@/lib/supabase-admin"
import { pickClosureSubmissionToken } from "@/lib/portal/submission-token"
import { reportSystemError } from "@/lib/system-errors"

// A failed lookup silently brings back the duplicate-row problem this exists to
// prevent (bug-hunter review), so it is reported, not just logged.
function reportLookupFailure(msg: string, closureServiceDeliveryId: string) {
  console.error("[resolveClosureSubmissionToken] lookup failed:", msg)
  reportSystemError({
    source: "server",
    route: "lib/portal/closure-submission-token",
    message: `closure re-send token lookup failed (a re-send may create a second submission row): ${msg}`,
    context: { closureServiceDeliveryId },
  }).catch(() => {})
}

/**
 * Token to save a closure form under: the one ALREADY used for this closure
 * by this person (so a re-send updates the same row even when the name or the
 * calendar year — both baked into the fresh token — changed), else the fresh
 * one. Antonio, 2026-09-24. See pickClosureSubmissionToken for the matching
 * rule.
 *
 * Scope: same PERSON only — a co-member's send must never take over another
 * member's saved answers (senior-engineer review) — and, for a company
 * closure, also a row this person saved before the company was linked.
 * Any lookup failure falls back to the fresh token (the pre-existing
 * behaviour); a submit is never blocked by it.
 */
export async function resolveClosureSubmissionToken(p: {
  freshToken: string
  closureServiceDeliveryId: string
  contactId: string | null
  accountId: string | null
}): Promise<string> {
  if (!p.contactId && !p.accountId) return p.freshToken
  try {
    let q = supabaseAdmin
      .from("closure_submissions")
      .select("token")
      .like("token", `portal-%-${String(p.closureServiceDeliveryId).slice(0, 8)}`)
      .order("created_at", { ascending: false })
      .limit(5)
    if (p.contactId) {
      q = q.eq("contact_id", p.contactId)
      // accountId comes from the request body — only interpolate a well-formed uuid.
      const safeAccountId = p.accountId && /^[0-9a-f-]{36}$/i.test(p.accountId) ? p.accountId : null
      q = safeAccountId ? q.or(`account_id.eq.${safeAccountId},account_id.is.null`) : q.is("account_id", null)
    } else {
      q = q.eq("account_id", p.accountId as string)
    }
    const { data, error } = await q
    if (error) {
      reportLookupFailure(error.message, p.closureServiceDeliveryId)
      return p.freshToken
    }
    return pickClosureSubmissionToken({
      freshToken: p.freshToken,
      closureServiceDeliveryId: p.closureServiceDeliveryId,
      existingTokens: ((data ?? []) as Array<{ token: string }>).map((r) => r.token),
    })
  } catch (err) {
    reportLookupFailure(err instanceof Error ? err.message : String(err), p.closureServiceDeliveryId)
    return p.freshToken
  }
}
