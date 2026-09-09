'use server'

import type { ActionResult } from '@/lib/server-action'
import type { CreateInvoiceInput } from '@/lib/schemas/invoice'

// Retired (dev job ef5da377, council review before the /payments → /finance
// redirect shipped). The page that rendered buttons for these is gone, but a
// Next.js Server Action is independently POST-callable by its own reference
// regardless of whether any page still renders a trigger for it — so the
// route-level redirect alone does NOT stop these from running. Three
// reviewers independently confirmed real risk if left live: markInvoicePaid
// duplicated a money-overwrite bug Finance's own equivalent was hardened
// against tonight; voidInvoice writes via supabaseAdmin (bypasses RLS) with
// no auth/role check of its own, relying entirely on RLS to keep a client
// from reaching it — which supabaseAdmin skips. Every export below is
// neutered to a safe no-op instead of deleted, so the file stays for
// history without staying live.

export async function updateInvoice(
  _paymentId: string,
  _updatedAt: string,
  _input: Omit<CreateInvoiceInput, 'account_id'>
): Promise<ActionResult> {
  return { success: false, error: 'This page has been retired. Use Finance instead.' }
}

export async function markInvoicePaid(
  _paymentId: string,
  _updatedAt: string,
  _paymentMethod?: string
): Promise<ActionResult> {
  return { success: false, error: 'This page has been retired. Use Finance instead.' }
}

export async function voidInvoice(
  _paymentId: string,
  _updatedAt: string
): Promise<ActionResult> {
  return { success: false, error: 'This page has been retired. Use Finance instead.' }
}

export async function deleteInvoice(
  _paymentId: string
): Promise<ActionResult> {
  return { success: false, error: 'This page has been retired. Use Finance instead.' }
}

// getInvoiceWithItems moved to app/(dashboard)/shared/invoice-actions.ts
// 2026-09-08 (dev job ef5da377) — Finance's own new line-item editor needs
// it too, same reason createInvoice/createCreditNote/etc. moved earlier.
