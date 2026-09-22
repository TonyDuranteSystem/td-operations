import { supabaseAdmin } from '@/lib/supabase-admin'
import { OnboardingReviewList } from './components/onboarding-review-list'

// ─── Types ──────────────────────────────────────────────────

export interface OnboardingReviewEntry {
  id: string
  token: string
  entity_type: string | null
  state: string | null
  language: string | null
  completed_at: string | null
  lead_name: string
  lead_email: string
  submitted_data: Record<string, unknown>
  changed_fields: Record<string, { old: unknown; new: unknown }> | null
  upload_paths: string[]
}

// ─── Page ───────────────────────────────────────────────────
//
// The staff-facing side of the new Onboarding Workspace (dev job bc2a8f7f):
// every submission a client has completed but no staff member has reviewed
// yet. Nothing about the account/CRM has been created for any of these —
// that only happens once a staff member opens one, checks the data and
// documents, and confirms (Antonio's 2026-09-20 decision reversing the old
// "auto-create, no review" rule).

export default async function OnboardingReviewPage() {
  const { data: submissions } = await supabaseAdmin
    .from('onboarding_submissions')
    .select('id, token, entity_type, state, language, completed_at, created_at, lead_id, contact_id, submitted_data, changed_fields, upload_paths')
    .eq('status', 'completed')
    .is('reviewed_at', null)
    // completed_at is never set on the real portal-wizard path (confirmed
    // live, 2026-09-20 QA) — ordering by it put every real submission at an
    // unpredictable position instead of oldest-first. created_at is always set.
    .order('created_at', { ascending: true })
    .limit(100)

  const leadIds = Array.from(
    new Set((submissions || []).map((s) => s.lead_id).filter((id): id is string => !!id)),
  )

  const leadMap = new Map<string, { full_name: string | null; email: string | null }>()
  if (leadIds.length > 0) {
    const { data: leads } = await supabaseAdmin
      .from('leads')
      .select('id, full_name, email')
      .in('id', leadIds)
    for (const lead of leads || []) {
      leadMap.set(lead.id, { full_name: lead.full_name, email: lead.email })
    }
  }

  // Real client-journey submissions (portal wizard) never carry a lead_id —
  // the person is already a Contact (their portal login exists from
  // offer-send). Without this fallback every one of those rows showed
  // "Unknown" for the client's name and email.
  const contactIds = Array.from(
    new Set(
      (submissions || [])
        .filter((s) => !s.lead_id && s.contact_id)
        .map((s) => s.contact_id as string),
    ),
  )
  const contactMap = new Map<string, { full_name: string | null; email: string | null }>()
  if (contactIds.length > 0) {
    const { data: contacts } = await supabaseAdmin
      .from('contacts')
      .select('id, full_name, email')
      .in('id', contactIds)
    for (const contact of contacts || []) {
      contactMap.set(contact.id, { full_name: contact.full_name, email: contact.email })
    }
  }

  const entries: OnboardingReviewEntry[] = (submissions || []).map((s) => {
    const lead = s.lead_id ? leadMap.get(s.lead_id) : null
    const contact = !lead && s.contact_id ? contactMap.get(s.contact_id) : null
    const person = lead || contact
    const submitted = (s.submitted_data as Record<string, unknown>) || {}
    return {
      id: s.id,
      token: s.token,
      entity_type: s.entity_type,
      // The `state` column is never written on the real portal-wizard path
      // (confirmed live, 2026-09-20 QA — a real submission showed the raw
      // column's leftover/default value instead of the state the client
      // actually entered). submitted_data always carries the real answer on
      // that path; the older manual-tool path sets the column directly at
      // creation and doesn't put state_of_formation in submitted_data, so
      // this falls back to the column there.
      state: (submitted.state_of_formation as string) || s.state,
      language: s.language,
      // Same gap for completed_at — never set on the real portal-wizard
      // path. created_at is always set and is the closest honest substitute.
      completed_at: s.completed_at || s.created_at,
      lead_name: person?.full_name || 'Unknown',
      lead_email: person?.email || '',
      submitted_data: submitted,
      changed_fields: s.changed_fields as Record<string, { old: unknown; new: unknown }> | null,
      upload_paths: (s.upload_paths as string[]) || [],
    }
  })

  return (
    <div className="p-6 lg:p-8 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Onboarding Review</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Clients who submitted their onboarding data and are waiting on a review. Nothing
          gets created in the CRM until you open one, check the data and documents, and confirm.
        </p>
      </div>

      {entries.length === 0 ? (
        <div className="bg-white rounded-lg border p-8 text-center">
          <p className="text-muted-foreground">Nothing waiting on review right now.</p>
        </div>
      ) : (
        <OnboardingReviewList entries={entries} />
      )}
    </div>
  )
}
