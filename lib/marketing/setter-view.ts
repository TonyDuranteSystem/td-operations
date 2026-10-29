/**
 * What a setter is not shown (server; TD Marketing, dev job 9aec66fa; 29 Oct 2026, Rocco through Antonio: "the setter should not see the link, the payment link, or the paid one").
 * `setterActorsOf` says which people of a team are setters (setter only), by email, the way the history names them; `sellerSideTest` says whether a stage is on Rocco's side of the road
 * (contacted, link sent, not ready, paid and after, archived): to a setter such a lead is simply "with the seller". The pure rules are in lead-privacy.ts and lead-actions.ts.
 */
import { listMembers } from "@/lib/marketing/members"
import { getMarketingSetting } from "@/lib/marketing/settings"
import { effectivePermissions } from "@/lib/marketing/permissions"
import { isSetterOnly } from "@/lib/marketing/lead-chat"
import { onSellerSide } from "@/lib/marketing/lead-actions"
import type { SellerResultStages } from "@/lib/marketing/settings-schema"

export async function setterActorsOf(teamId: string): Promise<Set<string>> {
  const bundles = (await getMarketingSetting("permission_bundles", teamId)) as Record<string, string[]>
  const rows = await listMembers(teamId)
  return new Set(rows
    .filter(m => m.status !== "removed" && m.email)
    .filter(m => isSetterOnly(effectivePermissions({ memberRole: m.member_role as "owner" | "member", bundle: m.bundle, bundles, extra: m.permissions }) as string[]))
    .map(m => String(m.email).trim().toLowerCase()))
}

export async function sellerSideTest(teamId: string): Promise<(status: string) => boolean> {
  const sellerStages = (await getMarketingSetting("seller_result_stages", teamId)) as SellerResultStages
  const paidStages = Array.from(new Set(Object.values((await getMarketingSetting("sale_kind_stages", teamId)) as Record<string, string>)))
  return (status: string) => onSellerSide(status, { sellerStages, paidStages })
}
