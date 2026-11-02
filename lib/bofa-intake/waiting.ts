/**
 * Calendar → "Applications to review": the bank applications a client has submitted that have not yet left for the bank
 * contact (Antonio 2026-11-02: "a notification in What's New in our calendar").
 *
 * It is its own tab, like "Payments to confirm", and not a What's New card: What's New is built from per-client chat events
 * and refuses an event with no client, and an applicant is not (yet) one of ours. The list is DERIVED from the table, never
 * stored: an application is on it exactly while the same rules the staff page uses (review-state.ts) say it is waiting, so
 * the tab and the buttons can never disagree, and an application disappears the moment it is submitted or sent back.
 *
 * SERVER-ONLY, READ-ONLY. Throws on a read error (the Calendar shows "could not load", never an empty "all clear"). If the
 * review columns do not exist yet in a database, it reads the long-standing columns and treats every unsent application as
 * needing review.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { isWaitingForStaff, reviewState, type ReviewState } from "./review-state"
import { readWithReviewColumns } from "./columns"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- new table not in the generated DB types
const table = () => (supabaseAdmin as any).from("bofa_intake_requests")

export interface WaitingApplication {
  id: string
  label: string
  partner: string | null
  applicant: string | null
  company: string | null
  completedAt: string | null
  state: ReviewState
  error: string | null
}

interface Row {
  id: string
  label: string
  partner_name: string | null
  status: string
  email_status: string | null
  email_error: string | null
  completed_at: string | null
  reviewed_at?: string | null
  returned_at?: string | null
  client_name: string | null
  client_company: string | null
}

const BASE = "id, label, partner_name, status, email_status, email_error, completed_at, client_name:form_data->>full_name, client_company:form_data->>company_name"

/** PURE: keep the rows still on staff's desk, oldest first (the one that has waited longest is on top). */
export function pickWaitingApplications(rows: Row[]): WaitingApplication[] {
  return rows
    .filter((r) => isWaitingForStaff(r))
    .map((r) => ({
      id: r.id,
      label: r.label,
      partner: r.partner_name,
      applicant: r.client_name,
      company: r.client_company,
      completedAt: r.completed_at,
      state: reviewState(r) as ReviewState,
      error: r.email_error,
    }))
    .sort((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? ""))
}

export async function loadWaitingApplications(): Promise<WaitingApplication[]> {
  const { data, error } = await readWithReviewColumns<Row[]>(BASE, (columns) =>
    table().select(columns).eq("status", "completed").order("completed_at", { ascending: false }).limit(300),
  )
  if (error) throw new Error(`bofa-intake: could not read the submitted applications: ${error.message}`)
  return pickWaitingApplications(data ?? [])
}
