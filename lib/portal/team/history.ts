/**
 * A team member's start date for the company's invoices and expenses (dev job e5d5400d; Antonio 2026-10-21: it is an option
 * the owner ticks when inviting someone). Same rule as new owners (lib/documents/history-cutoff.ts): a person added later does
 * not see what was saved before they joined, unless the owner ticked 'invoice_history' for them.
 *
 * Pure and client-safe. Returns the date they may see FROM, or null = sees everything (ticked, or no date known).
 */
import { hasCapability, type CapabilityFlags } from './capabilities'

export function teammateHistoryStart(t: { createdAt?: string | null; capabilities: CapabilityFlags | null | undefined }): string | null {
  if (hasCapability(t.capabilities, 'invoice_history')) return null
  if (!t.createdAt || Number.isNaN(Date.parse(t.createdAt))) return null
  return t.createdAt
}
