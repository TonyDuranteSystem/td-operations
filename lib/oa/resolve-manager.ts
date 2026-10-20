/**
 * Who is printed as "Manager" on a new Operating Agreement.
 *
 * A company can carry its own manager (`accounts.manager_name`) — a person who is
 * not an owner, e.g. Antonio Durante for Beril LLC (dev job d016d398). Blank keeps
 * the old behaviour: the manager is the company's flagged signer.
 *
 * Every place that creates an agreement calls this, so no door can disagree.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isMultiMemberEntity } from "@/lib/portal/entity-type"

/** Pure choice: the company's own manager when it has one, else the signer. */
export function pickOaManagerName(accountManagerName: string | null | undefined, signerName: string): string {
  const own = (accountManagerName ?? "").replace(/\s+/g, " ").trim()
  return own || signerName
}

export async function resolveOaManagerName(accountId: string | null | undefined, signerName: string): Promise<string> {
  if (!accountId) return signerName
  const { data, error } = await supabaseAdmin
    .from("accounts")
    .select("manager_name, entity_type, member_structure")
    .eq("id", accountId)
    .maybeSingle()
  // Fail closed: a legal document must not silently print the wrong Manager because a read failed.
  if (error) throw new Error(`Could not read the company's manager: ${error.message}`)
  // A separate Manager only makes sense for a multi-member company (the single-member signature block is the sole member's).
  if (!isMultiMemberEntity(data?.entity_type as string | null, data?.member_structure as string | null)) return signerName
  return pickOaManagerName(data?.manager_name, signerName)
}

/**
 * Members who cannot receive the signing link. The signing page identifies each
 * signer by email, so an agreement must not be issued without one for every member.
 */
export function membersMissingEmail(members: Array<{ full_name?: string | null; company_name?: string | null; name?: string | null; email?: string | null; representative_email?: string | null; member_email?: string | null }>): string[] {
  return members
    .filter(m => !(m.email || m.representative_email || m.member_email || "").trim())
    .map(m => (m.full_name || m.company_name || m.name || "A member").trim() || "A member")
}
