/**
 * "May THIS login see this one invoice?" with ONE identity decision (dev job e5d5400d).
 * A team member follows their own start date (lib/portal/team/history.ts); a client follows the start date on their company link.
 * Staff / unknown logins are never hidden anything here (the access check before this decides who may open the invoice).
 */
import type { User } from '@supabase/supabase-js'
import { resolvePortalIdentity, type PortalIdentity } from '@/lib/portal/resolve-portal-identity'
import { teammateHistoryStart } from '@/lib/portal/team/history'
import { getOpenedItemIds, isItemHiddenFromViewer } from '@/lib/portal/history-cutoff'
import { isItemHiddenByCutoff } from '@/lib/documents/history-cutoff'
import type { HistoryItemKind } from '@/lib/portal/history-item-kinds'

export interface ViewerHistoryDeps {
  resolve: (u: User) => Promise<PortalIdentity>
  openedIds: (accountId: string, kind: HistoryItemKind) => Promise<Set<string>>
  contactHidden: typeof isItemHiddenFromViewer
}
const defaults: ViewerHistoryDeps = { resolve: resolvePortalIdentity, openedIds: (a, k) => getOpenedItemIds(a, k), contactHidden: isItemHiddenFromViewer }

export async function isItemHiddenFromUser(
  p: { user: User; accountId: string | null | undefined; kind: HistoryItemKind; itemId: string; createdAt: string },
  deps: ViewerHistoryDeps = defaults,
): Promise<boolean> {
  if (!p.accountId) return false
  const identity = await deps.resolve(p.user)
  if (identity.kind === 'teammate') {
    const start = teammateHistoryStart(identity)
    if (!start) return false
    const opened = await deps.openedIds(p.accountId, p.kind)
    return isItemHiddenByCutoff({ created_at: p.createdAt, opened: opened.has(p.itemId) }, start, null)
  }
  if (identity.kind === 'contact') {
    return deps.contactHidden({ accountId: p.accountId, contactId: identity.contactId, kind: p.kind, itemId: p.itemId, item: { created_at: p.createdAt } })
  }
  return false
}
