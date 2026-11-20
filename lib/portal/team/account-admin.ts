/**
 * Portal Team Access — who may manage a company's team.
 *
 * Step 3 of Team Powers (2026-11-17): the old "one main person" (override → SS-4 signer → owner role → sole contact)
 * is GONE. Any current owner or member of THIS company may manage its team — the rule and its reasons live in
 * lib/portal/team/may-manage.ts.
 *
 * `isAccountAdmin` keeps its name only because seven places (the Team page, the layout, the home page, the phone app
 * loader and the three team API routes through assertAccountAdmin) already call it; it now simply means "may manage the team".
 */
import { mayManageTeam, type MayManageDeps } from '@/lib/portal/team/may-manage'

/** True if the given contact may manage the company's team (a current owner or member of that company). */
export async function isAccountAdmin(
  contactId: string,
  accountId: string,
  deps?: MayManageDeps,
): Promise<boolean> {
  return mayManageTeam(contactId, accountId, deps)
}
