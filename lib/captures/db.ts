/**
 * `staff_captures` is NOT in the generated DB types (added by migration
 * scripts/migrations/20260904-1500-staff-captures.sql, after the last
 * `gen:types` run) — mirrors lib/notes/staff-notes.ts's own notesTable()
 * for the identical reason: a direct typed `.from('staff_captures')` FAILS
 * THE BUILD (`error TS2769: No overload matches this call`). Route through
 * this helper, never call `.from('staff_captures')` directly.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const capturesTable = () => (supabaseAdmin as any).from("staff_captures")
