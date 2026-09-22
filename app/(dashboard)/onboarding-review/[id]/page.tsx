import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, CheckCircle2, Circle, MessageCircle } from 'lucide-react'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { categorizeSubmittedFields } from '@/lib/flows/onboarding-field-categories'
import { OnboardingWorkspaceDetail } from './components/onboarding-workspace-detail'
import { OnboardingRaSwitchStep } from '@/components/flows/onboarding-ra-switch-step'
import type { OnboardingReviewEntry } from '../page'

export const dynamic = 'force-dynamic'

/**
 * Onboarding Workspace — the real per-client workspace page (dev job
 * bc2a8f7f). Antonio, 2026-09-22, explicit numbered spec, matched 1:1 below:
 *   1. client info + documents           → OnboardingWorkspaceDetail, section 1
 *   2. company info + documents          → OnboardingWorkspaceDetail, section 2
 *   3. review the data                   → ConfirmPanel (inside section 2 above)
 *   4. reviewed                          → onboarding_submissions.reviewed_at
 *   5. account created, docs in folder   → the existing confirm→job chain (unchanged)
 *   6. Harbor Compliance RA switch, last → OnboardingRaSwitchStep below — a
 *      MANUAL switch staff do on Harbor Compliance's own site, then confirm
 *      here (not an API push — Antonio corrected this: "that fucking button
 *      must open the website for us to do switch. once is done, we will
 *      confirm in the workspace and the system will update the crm")
 *   7. everything with stages            → the 3-dot stepper below
 * Message-the-client link at the top is visible regardless of stage
 * (Antonio: "add the chat in every stage").
 * [id] = onboarding_submissions.id. Reached from the compact
 * OnboardingWorkspaceBanner on the account/contact page, and from the
 * global /onboarding-review inbox.
 */
export default async function OnboardingWorkspacePage({ params }: { params: { id: string } }) {
  const { data: sub } = await supabaseAdmin
    .from('onboarding_submissions')
    .select(
      'id, token, entity_type, state, language, completed_at, created_at, lead_id, contact_id, account_id, status, reviewed_at, submitted_data, changed_fields, upload_paths',
    )
    .eq('id', params.id)
    .maybeSingle()

  if (!sub) notFound()

  const [{ data: lead }, { data: contact }, { data: stageRows }] = await Promise.all([
    sub.lead_id
      ? supabaseAdmin.from('leads').select('full_name, email').eq('id', sub.lead_id).maybeSingle()
      : Promise.resolve({ data: null }),
    sub.contact_id
      ? supabaseAdmin.from('contacts').select('full_name, email').eq('id', sub.contact_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabaseAdmin
      .from('pipeline_stages')
      .select('stage_name, stage_order')
      .eq('service_type', 'Client Onboarding')
      .order('stage_order', { ascending: true }),
  ])

  const person = lead || contact
  const submitted = (sub.submitted_data as Record<string, unknown>) || {}
  const entry: OnboardingReviewEntry = {
    id: sub.id,
    token: sub.token,
    entity_type: sub.entity_type,
    state: (submitted.state_of_formation as string) || sub.state,
    language: sub.language,
    completed_at: sub.completed_at || sub.created_at,
    lead_name: person?.full_name || 'Unknown',
    lead_email: person?.email || '',
    submitted_data: submitted,
    changed_fields: sub.changed_fields as Record<string, { old: unknown; new: unknown }> | null,
    upload_paths: (sub.upload_paths as string[]) || [],
  }
  const companyName = (submitted.company_name as string) || 'Unnamed company'
  const { client: clientFields, company: companyFields } = categorizeSubmittedFields(submitted)

  const reviewed = !!sub.reviewed_at
  const stages = stageRows ?? []
  const finalStageOrder = stages.length > 0 ? stages[stages.length - 1].stage_order : 3

  // Once reviewed, the account exists (or is being created in the background
  // — account_id lands on this row a little after reviewed_at, see
  // lib/jobs/handlers/onboarding-setup.ts step 8). Find the resulting
  // 'Client Onboarding' SD — its OWN stage is the real signal for whether the
  // RA switch is still pending or already confirmed done.
  let onboardingSd: { id: string; account_id: string | null; stage_order: number | null } | null = null
  if (reviewed && sub.account_id) {
    const { data: sd } = await supabaseAdmin
      .from('service_deliveries')
      .select('id, account_id, stage_order')
      .eq('account_id', sub.account_id)
      .eq('service_type', 'Client Onboarding')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    onboardingSd = sd
  }
  const raSwitchConfirmed = !!onboardingSd && onboardingSd.stage_order === finalStageOrder

  // 3 fixed real stages (pipeline_stages, service_type='Client Onboarding'):
  // Data Collection (client already submitted, always done here) → Review &
  // CRM Setup (current until reviewed) → Post-Review & Closing (RA switch,
  // done once staff confirms it below).
  const currentStageOrder = !reviewed ? 2 : raSwitchConfirmed ? finalStageOrder + 1 : finalStageOrder

  const backHref = sub.account_id
    ? `/accounts/${sub.account_id}`
    : sub.contact_id
      ? `/contacts/${sub.contact_id}`
      : '/onboarding-review'

  // Message the client — visible at every stage of this workspace, not just
  // at the end (Antonio, 2026-09-22: "add the chat in every stage"). Deep-links
  // straight into this client's real portal-chat thread.
  const chatHref = sub.account_id
    ? `/portal-chats?account=${sub.account_id}`
    : sub.contact_id
      ? `/portal-chats?contact=${sub.contact_id}`
      : null

  return (
    <div className="mx-auto max-w-4xl p-6 lg:p-8">
      <div className="mb-4 flex items-center justify-between gap-3">
        <Link
          href={backHref}
          className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-800"
        >
          <ArrowLeft className="h-4 w-4" />
          {companyName}
        </Link>
        {chatHref && (
          <Link
            href={chatHref}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-100"
          >
            <MessageCircle className="h-4 w-4" />
            Message {entry.lead_name !== 'Unknown' ? entry.lead_name : 'the client'}
          </Link>
        )}
      </div>

      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-zinc-900">Onboarding — {companyName}</h1>
        <p className="mt-0.5 text-sm text-zinc-500">
          {entry.entity_type || '—'} · {entry.state || '—'} · submitted by {entry.lead_name}
        </p>
      </div>

      <div className="mb-6 overflow-x-auto pb-1">
        <ol className="flex items-center gap-2">
          {stages.map((s, i) => {
            const done = s.stage_order < currentStageOrder
            const current = s.stage_order === currentStageOrder
            return (
              <li key={s.stage_name} className="flex items-center gap-2">
                {i > 0 && <span className="h-px w-8 bg-zinc-200" />}
                <span
                  className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium ${
                    done
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                      : current
                        ? 'border-indigo-300 bg-indigo-50 text-indigo-900'
                        : 'border-zinc-200 bg-zinc-50 text-zinc-400'
                  }`}
                >
                  {done ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
                  {s.stage_name}
                </span>
              </li>
            )
          })}
        </ol>
      </div>

      {!reviewed ? (
        <OnboardingWorkspaceDetail entry={entry} clientFields={clientFields} companyFields={companyFields} />
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            Reviewed. {sub.account_id ? 'The account was created and documents were copied to its folder.' : 'The account is being created in the background — this usually takes a few minutes.'}
          </div>
          {raSwitchConfirmed ? (
            <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              Registered Agent switched. Onboarding complete.
            </div>
          ) : onboardingSd ? (
            <OnboardingRaSwitchStep submissionId={sub.id} />
          ) : sub.account_id ? (
            <p className="text-sm text-zinc-500">
              Setting up the account&apos;s services — refresh in a moment to switch the Registered Agent.
            </p>
          ) : null}
        </div>
      )}
    </div>
  )
}
