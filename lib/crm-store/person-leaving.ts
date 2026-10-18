/**
 * A person is removed as a MEMBER of a company (Storage check Phase 2, dev job 7cac86c0; Antonio 2026-10-17: "removing the member:
 * stop access unless he owns another company"). Their portal access to THIS company ends (the account_contacts link goes); their
 * login and every other company they are linked to are never touched. Nothing is emailed to them (the client asks, we send).
 *
 * Kept when ending it would hurt: the person is STILL another member of this company, or is its PRIMARY contact (staff change the
 * primary first). Never throws — the member removal that called it has already happened.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

export interface EndAccessResult { accessEnded: boolean; warning: string | null }

export type LeavingDb = Pick<typeof supabaseAdmin, "from">

export async function endPortalAccessForRemovedMember(p: { accountId: string; contactId: string | null; memberType: string | null }, d: LeavingDb = supabaseAdmin): Promise<EndAccessResult> {
  try {
    if (!p.contactId || p.memberType === "company") return { accessEnded: false, warning: null }
    const { count: stillMember } = await d.from("members").select("id", { count: "exact", head: true }).eq("account_id", p.accountId).eq("contact_id", p.contactId)
    if ((stillMember ?? 0) > 0) return { accessEnded: false, warning: "The person is still listed as another member of this company, so their portal access was kept." }
    const { data: link } = await d.from("account_contacts").select("is_primary").eq("account_id", p.accountId).eq("contact_id", p.contactId).maybeSingle()
    if (!link) return { accessEnded: false, warning: null }
    if ((link as { is_primary?: boolean }).is_primary) {
      return { accessEnded: false, warning: "The person is this company's primary contact, so their portal access was kept — change the primary contact first, then unlink them." }
    }
    const { error } = await d.from("account_contacts").delete().eq("account_id", p.accountId).eq("contact_id", p.contactId)
    if (error) return { accessEnded: false, warning: "The member was removed but their portal access could not be ended — unlink them from the company page." }
    return { accessEnded: true, warning: null }
  } catch (e) {
    return { accessEnded: false, warning: `The member was removed but their portal access could not be checked (${e instanceof Error ? e.message : "error"}) — check the company page.` }
  }
}
