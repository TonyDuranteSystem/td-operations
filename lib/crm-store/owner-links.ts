/**
 * Whose CRM record a store file belongs to: the account (company) and/or the contact (client) its `documents` row is linked to.
 * ONE place for it (dev job 1992a087, P3 step B): the staff upload and the Mac app's save both use it, so they cannot drift.
 *   - a company storage → its account; a person storage → its contact;
 *   - a company still being formed → the client (and account, once linked) of the formation case;
 *   - a person's document uploaded from a company page keeps BOTH links (`companyAccount`).
 * Both null = the storage is not linked to anyone: nothing may be added there.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

export interface OwnerLinkInput { kind: string; account_id: string | null; contact_id: string | null; service_delivery_id: string | null }

export async function rowLinksForOwner(owner: OwnerLinkInput, companyAccount: string | null = null): Promise<{ account: string | null; contact: string | null }> {
  let account: string | null = owner.kind === "company" ? owner.account_id : companyAccount
  let contact: string | null = owner.kind === "person" ? owner.contact_id : null
  if (owner.kind === "formation" && owner.service_delivery_id) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- service_deliveries columns read loosely
    const { data: sd } = await (supabaseAdmin as any).from("service_deliveries").select("account_id, contact_id").eq("id", owner.service_delivery_id).maybeSingle()
    account = (sd?.account_id as string | null) ?? null
    contact = (sd?.contact_id as string | null) ?? null
  }
  return { account, contact }
}
