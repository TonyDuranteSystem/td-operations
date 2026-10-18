/**
 * CRM Store — open a company's OWN storage when a flow needs a place for its files (Stop Drive S1d, dev job 264bb882).
 *
 * A company that is created by onboarding, "place client" or a standalone tax-return intake used to get its Drive folder from
 * the folder helper. Folders are no longer created, so the flow opens the company's storage instead (the same call the
 * cutover and the one-time customers use: `store_ensure_owner` kind company + the company folder template). Idempotent: a
 * company that already has a live storage is returned as it is; a read or open failure throws (the caller reports it).
 */

export async function ensureCompanyStorage(accountId: string, companyName: string): Promise<string> {
  const { liveOwnerOfAccount } = await import("./switched-drive-guard")
  const existing = await liveOwnerOfAccount(accountId)
  if (existing) return existing
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  const { COMPANY_TEMPLATE, storeSafeFolderName } = await import("./formation-pilot")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* functions are not in the generated types
  const db = supabaseAdmin as any
  const { data: ownerId, error } = await db.rpc("store_ensure_owner", { p_kind: "company", p_ref: accountId })
  if (error || !ownerId) throw new Error(`Could not open this company's storage — ${error?.message ?? "no id"}`)
  const { error: tErr } = await db.rpc("store_apply_template", { p_owner_id: ownerId, p_template_slug: COMPANY_TEMPLATE, p_root_name: storeSafeFolderName(companyName || "Company") })
  if (tErr) throw new Error(`Could not create this company's folders — ${tErr.message}`)
  return ownerId as string
}
