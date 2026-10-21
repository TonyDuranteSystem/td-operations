/**
 * Which company an invoicing page works on, for ONE identity decision (dev job e5d5400d).
 *
 * A login that is a team member (a colleague added on the Team page) ALWAYS acts as that team member,
 * even if its token also carries a contact id (a mixed login). Server writes are gated by
 * `canAccessAccount`, which already resolves the same way, so a page must not decide differently:
 * before this, the pages looked at the contact id first and showed a mixed login the owner's whole menu
 * while the buttons were refused.
 *
 * Dependencies are injectable so the rule is unit-tested without a database.
 */
import type { User } from '@supabase/supabase-js'
import { resolvePortalIdentity, type PortalIdentity } from '@/lib/portal/resolve-portal-identity'
import { hasCapability, type CapabilityFlags, type TeamCapability } from '@/lib/portal/team/capabilities'

export type InvoiceActor =
  | { kind: 'contact'; contactId: string; accountIds: string[] }
  | { kind: 'teammate'; accountId: string; capabilities: CapabilityFlags }

export interface InvoiceActorDeps {
  resolve: (user: User) => Promise<PortalIdentity>
}

const defaultDeps: InvoiceActorDeps = { resolve: resolvePortalIdentity }

/**
 * The actor, or null (deny). A team member must hold `capability`; a client always passes.
 * Pass `null` as capability to only identify (the page decides per tab afterwards).
 */
export async function resolveInvoiceActor(
  user: User,
  capability: TeamCapability | null,
  deps: InvoiceActorDeps = defaultDeps,
): Promise<InvoiceActor | null> {
  const identity = await deps.resolve(user)
  if (identity.kind === 'contact') return { kind: 'contact', contactId: identity.contactId, accountIds: identity.accountIds }
  if (identity.kind === 'teammate') {
    if (capability && !hasCapability(identity.capabilities, capability)) return null
    return { kind: 'teammate', accountId: identity.accountId, capabilities: identity.capabilities }
  }
  return null
}
