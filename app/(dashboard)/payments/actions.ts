'use server'

import type { ActionResult } from '@/lib/server-action'
import type { CreatePaymentInput, UpdatePaymentInput } from '@/lib/schemas/payment'

// Retired (dev job ef5da377, council review before the /payments → /finance
// redirect shipped). The page that rendered buttons for these is gone, but a
// Next.js Server Action is independently POST-callable by its own reference
// regardless of whether any page still renders a trigger for it — so the
// route-level redirect alone does NOT stop these from running. Three
// reviewers independently confirmed real risk if left live: markPaymentPaid
// could silently overwrite a genuinely Partial invoice as fully Paid (the
// exact bug Finance's own equivalent was hardened against tonight, never
// backported here since this file was meant to be dead); voidInvoice writes
// via supabaseAdmin (bypasses RLS) with no auth/role check of its own,
// relying entirely on RLS to keep a client from reaching it — which
// supabaseAdmin skips. Every export below is neutered to a safe no-op
// instead of deleted, so the file stays for history without staying live.

export async function markPaymentPaid(_paymentId: string, _updatedAt?: string): Promise<ActionResult> {
  return { success: false, error: 'This page has been retired. Use Finance instead.' }
}

export async function updatePaymentStatus(_paymentId: string, _status: string, _updatedAt?: string): Promise<ActionResult> {
  return { success: false, error: 'This page has been retired. Use Finance instead.' }
}

export async function createPayment(_input: CreatePaymentInput): Promise<ActionResult<{ id: string }>> {
  return { success: false, error: 'This page has been retired. Use Finance instead.' }
}

export async function updatePayment(_input: UpdatePaymentInput): Promise<ActionResult> {
  return { success: false, error: 'This page has been retired. Use Finance instead.' }
}

export async function addPaymentNote(_paymentId: string, _note: string, _updatedAt: string): Promise<ActionResult> {
  return { success: false, error: 'This page has been retired. Use Finance instead.' }
}
