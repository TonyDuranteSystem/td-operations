/**
 * Per-client Onboarding Workspace data — the account/contact page's data-fetch
 * side of components/flows/onboarding-workspace-banner.tsx (dev job bc2a8f7f,
 * Antonio 2026-09-22: review must happen on the client's own page, not only
 * the global /onboarding-review inbox).
 *
 * Two independent signals, since onboarding deliberately creates nothing
 * until staff confirms (staff-review-first design):
 *   - PENDING: onboarding_submissions rows for this contact, completed but
 *     not yet reviewed. Mirrors app/(dashboard)/onboarding-review/page.tsx's
 *     entry-building exactly, scoped to one contact instead of everyone.
 *   - REVIEWED: 'Client Onboarding' service_deliveries for this contact still
 *     sitting at the "Review & CRM Setup" stage (stage_order 2 — the stage
 *     the SD is created into the moment staff confirms). Staff manually
 *     advancing the SD past this stage once the Registered Agent is switched
 *     is what retires this card — no extra DB flag needed.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import type { OnboardingReviewEntry } from "@/app/(dashboard)/onboarding-review/page"

export interface ReviewedOnboarding {
  companyName: string | null
  serviceDeliveryId: string
  accountId: string | null
}

export interface OnboardingWorkspaceData {
  pendingEntries: OnboardingReviewEntry[]
  reviewed: ReviewedOnboarding[]
}

export const EMPTY_ONBOARDING_WORKSPACE: OnboardingWorkspaceData = { pendingEntries: [], reviewed: [] }

export async function resolveOnboardingWorkspaceForContact(
  contactId: string,
): Promise<OnboardingWorkspaceData> {
  const [{ data: submissions }, { data: contact }, { data: sds }] = await Promise.all([
    supabaseAdmin
      .from("onboarding_submissions")
      .select(
        "id, token, entity_type, state, language, completed_at, created_at, submitted_data, changed_fields, upload_paths",
      )
      .eq("contact_id", contactId)
      .eq("status", "completed")
      .is("reviewed_at", null)
      .order("created_at", { ascending: true }),
    supabaseAdmin.from("contacts").select("full_name, email").eq("id", contactId).maybeSingle(),
    supabaseAdmin
      .from("service_deliveries")
      .select("id, service_name, account_id")
      .eq("contact_id", contactId)
      .eq("service_type", "Client Onboarding")
      .eq("stage_order", 2)
      .eq("status", "active"),
  ])

  const pendingEntries: OnboardingReviewEntry[] = (submissions || []).map((s) => {
    const submitted = (s.submitted_data as Record<string, unknown>) || {}
    return {
      id: s.id,
      token: s.token,
      entity_type: s.entity_type,
      state: (submitted.state_of_formation as string) || s.state,
      language: s.language,
      completed_at: s.completed_at || s.created_at,
      lead_name: contact?.full_name || "Unknown",
      lead_email: contact?.email || "",
      submitted_data: submitted,
      changed_fields: s.changed_fields as Record<string, { old: unknown; new: unknown }> | null,
      upload_paths: (s.upload_paths as string[]) || [],
    }
  })

  const reviewed: ReviewedOnboarding[] = (sds || []).map((sd) => ({
    companyName: (sd.service_name as string | null)?.replace(/^Client Onboarding - /, "") ?? null,
    serviceDeliveryId: sd.id,
    accountId: sd.account_id,
  }))

  return { pendingEntries, reviewed }
}
