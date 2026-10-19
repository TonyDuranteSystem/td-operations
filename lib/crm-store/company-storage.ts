/**
 * CRM Store — open a company's OWN storage when a flow needs a place for its files (Stop Drive S1d, dev job 264bb882).
 *
 * A company that is created by onboarding, "place client" or a standalone tax-return intake used to get its Drive folder from
 * the folder helper. Folders are no longer created, so the flow opens the company's storage instead (the same call the
 * cutover and the one-time customers use: `store_ensure_owner` kind company + the company folder template). Idempotent: a
 * company that already has a live storage is returned as it is.
 *
 * It NEVER opens a second owner while the buyer's formation already has one: a company created from a formation whose case owns
 * a storage must get that storage attached (staff / the formation hand-over), not a new empty one beside it (the attach would then
 * refuse "company already has its own storage"). A study-only owner is not a live storage and is never treated as one.
 */

export class FormationOwnerPendingError extends Error {
  constructor() {
    super("This company's formation already has its own storage — the company gets that one (it is attached to the company), no second storage is opened.")
    this.name = "FormationOwnerPendingError"
  }
}

/** Live formation owners of the open formation cases of the people linked to this company (the company itself not attached yet). */
export async function pendingFormationOwners(accountId: string): Promise<string[]> {
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* tables are not in the generated types
  const db = supabaseAdmin as any
  const { data: links, error: lErr } = await db.from("account_contacts").select("contact_id").eq("account_id", accountId)
  if (lErr) throw new Error("Could not check this company's people — please try again.")
  const contactIds = ((links ?? []) as Array<{ contact_id: string | null }>).map((l) => l.contact_id).filter((x): x is string => !!x)
  if (contactIds.length === 0) return []
  const { data: sds, error: sErr } = await db.from("service_deliveries").select("id, account_id").in("contact_id", contactIds).eq("service_type", "Company Formation").eq("status", "active")
  if (sErr) throw new Error("Could not check the formation cases — please try again.")
  const sdIds = ((sds ?? []) as Array<{ id: string; account_id: string | null }>).filter((x) => !x.account_id || x.account_id === accountId).map((x) => x.id)
  if (sdIds.length === 0) return []
  const { data: owners, error: oErr } = await db.from("store_owners").select("id").eq("kind", "formation").eq("study_only", false).in("service_delivery_id", sdIds)
  if (oErr) throw new Error("Could not check the formation storages — please try again.")
  return ((owners ?? []) as Array<{ id: string }>).map((o) => o.id)
}

export async function ensureCompanyStorage(accountId: string, companyName: string): Promise<string> {
  const { liveOwnerOfAccount } = await import("./switched-drive-guard")
  const existing = await liveOwnerOfAccount(accountId)
  if (existing) return existing
  if ((await pendingFormationOwners(accountId)).length > 0) throw new FormationOwnerPendingError()
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  const { COMPANY_TEMPLATE, storeSafeFolderName } = await import("./formation-pilot")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* functions are not in the generated types
  const db = supabaseAdmin as any
  const { data: ownerId, error } = await db.rpc("store_ensure_owner", { p_kind: "company", p_ref: accountId })
  if (error || !ownerId) throw new Error(`Could not open this company's storage — ${error?.message ?? "no id"}`)
  // store_ensure_owner can hand back a hidden study copy: that is not a storage the company can use
  const { data: row, error: rErr } = await db.from("store_owners").select("study_only").eq("id", ownerId).maybeSingle()
  if (rErr) throw new Error(`Could not check the company's storage — ${rErr.message}`)
  if (row?.study_only) throw new Error("This company only has a hidden study copy of its storage, not a live one — staff must switch it on before files can be saved.")
  const { error: tErr } = await db.rpc("store_apply_template", { p_owner_id: ownerId, p_template_slug: COMPANY_TEMPLATE, p_root_name: storeSafeFolderName(companyName || "Company") })
  if (tErr) throw new Error(`Could not create this company's folders — ${tErr.message}`)
  return ownerId as string
}
