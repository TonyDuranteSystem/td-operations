/**
 * ONE doorway for every client-invoicing server action (dev job 1a23f5f1, council review 2026-10-09).
 *
 * The exported actions in app/portal/invoices/*-actions.ts are public endpoints: any logged-in portal user can
 * call them with any id. Before this module, the invoice actions checked nothing, so a client who knew another
 * company's invoice id could void it, mark it paid or rewrite it.
 *
 * RULES (each one earned in review):
 *  1. The company is ALWAYS taken from the STORED row, never from the caller's input. `authorizeInvoice(id)`
 *     loads client_invoices.account_id itself, so a forged `account_id` in the payload cannot widen access.
 *  2. Default-deny through `canAccessAccount` (contacts, teammates with the capability, staff).
 *  3. Foreign references (customer, bank account, template) must belong to the SAME company
 *     (`belongsToAccount`), otherwise one company's invoice could point at another company's customer and
 *     email that customer from the wrong identity, or print another company's bank details.
 *  4. A denied call returns the same message as a missing row, so ids cannot be probed.
 *
 * Dependencies are injectable so the guard is unit-tested without a database.
 */
import type { User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { canAccessAccount } from '@/lib/portal/team/gate'
import type { TeamCapability } from '@/lib/portal/team/capabilities'

export type AccessResult =
  | { ok: true; user: User; accountId: string }
  | { ok: false; error: string }

export const NOT_FOUND = 'Invoice not found'
export const DENIED = 'Access denied'
export const NOT_SIGNED_IN = 'Please sign in again.'

export interface AccessDeps {
  getUser: () => Promise<User | null>
  canAccess: (user: User | null, accountId: string | null | undefined, capability: TeamCapability) => Promise<boolean>
  loadInvoiceAccount: (invoiceId: string) => Promise<string | null>
}

const defaultDeps: AccessDeps = {
  getUser: async () => {
    const { data } = await createClient().auth.getUser()
    return data.user ?? null
  },
  canAccess: (user, accountId, capability) => canAccessAccount(user, accountId, capability),
  loadInvoiceAccount: async (invoiceId) => {
    const { data } = await supabaseAdmin.from('client_invoices').select('account_id').eq('id', invoiceId).maybeSingle()
    return data?.account_id ?? null
  },
}

/** The caller may act on THIS company (account-keyed actions: create, list, templates). */
export async function authorizeAccount(
  accountId: string | null | undefined,
  capability: TeamCapability = 'invoices_billing',
  deps: AccessDeps = defaultDeps,
): Promise<AccessResult> {
  const user = await deps.getUser()
  if (!user) return { ok: false, error: NOT_SIGNED_IN }
  if (!accountId) return { ok: false, error: DENIED }
  if (!(await deps.canAccess(user, accountId, capability))) return { ok: false, error: DENIED }
  return { ok: true, user, accountId }
}

/** The caller may act on THIS invoice. The company comes from the stored row. */
export async function authorizeInvoice(
  invoiceId: string,
  capability: TeamCapability = 'invoices_billing',
  deps: AccessDeps = defaultDeps,
): Promise<AccessResult> {
  const user = await deps.getUser()
  if (!user) return { ok: false, error: NOT_SIGNED_IN }
  if (!invoiceId) return { ok: false, error: NOT_FOUND }
  const accountId = await deps.loadInvoiceAccount(invoiceId)
  if (!accountId) return { ok: false, error: NOT_FOUND }
  if (!(await deps.canAccess(user, accountId, capability))) return { ok: false, error: NOT_FOUND }
  return { ok: true, user, accountId }
}

export type OwnedTable = 'client_customers' | 'client_bank_accounts' | 'client_invoice_templates'

/** True when the row exists AND belongs to the company. Used for every foreign reference a payload carries. */
export async function belongsToAccount(table: OwnedTable, id: string, accountId: string): Promise<boolean> {
  const { data } = await supabaseAdmin.from(table).select('id').eq('id', id).eq('account_id', accountId).maybeSingle()
  return !!data
}

/** Short name of the person acting, for the audit trail ("client:mario", never just "client"). */
export function actorLabel(user: User): string {
  const meta = user.app_metadata as Record<string, unknown> | undefined
  const kind = meta?.role === 'client' ? 'client' : 'staff'
  return `${kind}:${(user.email ?? 'unknown').split('@')[0]}`
}
