// lib/database.types.augmented.ts
//
// TEMPORARY type bridge — Slice 0 "Sent to India -> Sent to Accountant" (2026-06-09).
//
// The migration 20260609-rename-sent-to-india.sql adds new columns/enum/status label to the
// DB ALONGSIDE the old ones (two-phase rename). We deliberately do NOT regenerate
// database.types.ts yet (old columns still exist; we regenerate after Phase 2 drops them).
// This wrapper teaches the typed `supabaseAdmin` client about the new names so the renamed
// code compiles, WITHOUT hand-editing the generated database.types.ts.
//
// DESIGN — why status is widened ONLY on Insert/Update, not Row:
//   A typed SupabaseClient<Database> must stay ASSIGNABLE to functions that accept the
//   ORIGINAL SupabaseClient<Database> (e.g. resolvePaymentRecipient, pay-token helpers).
//   • Row is an OUTPUT (covariant): widening Row.status to a superset union would make the
//     augmented client NON-assignable to the original — so Row.status is left untouched and
//     we only ADD the new columns to Row (extra props are assignment-safe).
//   • Insert/Update are INPUTS (contravariant): widening their status to include
//     'Sent to Accountant' is safe and lets the send tool write the new label.
//   Reads of the new status value are plain string comparisons (status is `string` in
//   lib/types.ts / helper predicates), so a narrow Row.status union is sufficient.
//
// DELETE this file and regenerate database.types.ts once the old sent_to_india /
// india_status / sent_to_india_date / india_follow_up_count columns are dropped (Phase 2),
// and switch lib/supabase-admin.ts back to importing Database from ./database.types.
import type { Database as GeneratedDatabase } from "./database.types"

type Gen = GeneratedDatabase["public"]
type Tables = Gen["Tables"]
type Enums = Gen["Enums"]
type TaxReturns = Tables["tax_returns"]
type TaxSubs = Tables["tax_return_submissions"]

export type AccountantStatus = "Not Sent" | "Sent - Pending" | "In Progress" | "Completed" | "Filed"

// Widened status union for WRITES: every existing label plus the new one.
type WidenedStatus = Enums["tax_return_status"] | "Sent to Accountant"

type NewTaxCols = {
  sent_to_accountant: boolean | null
  sent_to_accountant_date: string | null
  accountant_status: AccountantStatus | null
  accountant_follow_up_count: number | null
}

// Slice 1/2: review-workflow columns on tax_return_submissions (added by
// 20260609-2015-tax-review-slice1-columns.sql, not yet in generated types).
// review_history is jsonb (typed `unknown` here — code guards with Array.isArray).
type NewSubsCols = {
  review_status: string | null
  review_history: unknown
}

export type Database = Omit<GeneratedDatabase, "public"> & {
  public: Omit<Gen, "Tables"> & {
    Tables: Omit<Tables, "tax_returns" | "tax_return_submissions"> & {
      tax_returns: Omit<TaxReturns, "Row" | "Insert" | "Update"> & {
        // Row: original (status untouched) + the new columns. No status widening here.
        Row: TaxReturns["Row"] & NewTaxCols
        // Insert/Update: new columns + widened status so writes can set 'Sent to Accountant'.
        Insert: Omit<TaxReturns["Insert"], "status"> &
          Partial<NewTaxCols> & { status?: WidenedStatus | null }
        Update: Omit<TaxReturns["Update"], "status"> &
          Partial<NewTaxCols> & { status?: WidenedStatus | null }
      }
      tax_return_submissions: Omit<TaxSubs, "Row" | "Insert" | "Update"> & {
        Row: TaxSubs["Row"] & NewSubsCols
        Insert: TaxSubs["Insert"] & Partial<NewSubsCols>
        Update: TaxSubs["Update"] & Partial<NewSubsCols>
      }
    }
  }
}
