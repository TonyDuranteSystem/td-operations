/**
 * Which company a login may subscribe its device to for push alerts (dev job e5d5400d).
 *
 * Push is sent per COMPANY, so a subscription to the wrong company leaks that company's message previews. A client is checked
 * against their companies elsewhere (unchanged). A TEAM MEMBER may subscribe only to their own company, and only with the chat
 * permission (the alerts are chat alerts). Anyone else (staff) is unchanged here.
 *
 * Pure, so it is unit-tested without a database.
 */
import type { PortalIdentity } from '@/lib/portal/resolve-portal-identity'
import { hasCapability } from './capabilities'

export interface PushScope {
  allowed: boolean
  /** The company to store the subscription under (a team member: their own); null = keep the caller's value. */
  accountId: string | null
  error?: string
}

export function pushSubscriptionScope(identity: PortalIdentity, requestedAccountId: string | null): PushScope {
  if (identity.kind !== 'teammate') return { allowed: true, accountId: null }
  if (!hasCapability(identity.capabilities, 'chat')) {
    return { allowed: false, accountId: null, error: 'Notifications are available to team members who can see chat.' }
  }
  if (requestedAccountId && requestedAccountId !== identity.accountId) {
    return { allowed: false, accountId: null, error: 'Access denied' }
  }
  return { allowed: true, accountId: identity.accountId }
}
