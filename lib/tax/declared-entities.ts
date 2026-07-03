/**
 * Declared related entities (Phase 3R slice 4 — amendment F2/F8).
 *
 * The tax wizard ALREADY collects related-party legal names
 * (`related_party_transactions[].rpt_company_name`) and now also collects
 * `other_owned_companies` (companies owned/controlled even with no
 * transactions). Until Phase 3R these answers were stored and IGNORED by
 * categorization. This helper extracts the declared names from a submission's
 * `submitted_data` so every pass can FLAG matching transactions as
 * related-party (is_related_party + note — never a category; the review card
 * / human answer decides the booking. NEVER feed these into own-entity
 * nameVariants — that would auto-book `conversion`, reviewer F2).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

interface SubmittedData {
  related_party_transactions?: Array<{ rpt_company_name?: string | null }> | null
  other_owned_companies?: string | null
}

/** PURE: declared entity names from a submission's submitted_data. */
export function declaredEntityNames(data: SubmittedData | null | undefined): string[] {
  if (!data) return []
  const names = new Set<string>()
  for (const rpt of data.related_party_transactions ?? []) {
    const n = (rpt?.rpt_company_name ?? "").trim()
    if (n.length >= 3) names.add(n)
  }
  for (const raw of (data.other_owned_companies ?? "").split(/[,\n;]+/)) {
    const n = raw.trim()
    if (n.length >= 3) names.add(n)
  }
  return Array.from(names)
}

/** Latest completed submission's declared entities for an account+year.
 *  Best-effort: any failure returns [] (flagging is an enhancement, never a
 *  blocker for categorization). */
export async function fetchDeclaredEntities(db: Db, accountId: string, taxYear: number): Promise<string[]> {
  try {
    const { data } = await db
      .from("tax_return_submissions")
      .select("submitted_data")
      .eq("account_id", accountId)
      .eq("tax_year", taxYear)
      .eq("status", "completed")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    return declaredEntityNames(data?.submitted_data as SubmittedData | null)
  } catch {
    return []
  }
}
