import { supabaseAdmin } from "@/lib/supabase-admin"
import type { Json } from "@/lib/database.types"

export interface MarkWizardProgressSubmittedParams {
  progressId: string | null
  wizardType: string
  data: Record<string, unknown>
  accountId: string | null
  contactId: string | null
  leadId: string | null
  offerId?: string | null
  serviceDeliveryId?: string | null
}

/**
 * The ONE place that marks a wizard_progress row 'submitted' (dev job
 * 9a9c5cf5 — app/api/portal/wizard-submit/route.ts previously had 3
 * independent copies of this insert/update, all silently swallowing the
 * write error). Every call site checks the returned `.error` itself, since
 * how to react differs: fail loud when this is the client's only proof of
 * success, log-and-continue when a more important write already succeeded
 * by this point.
 */
export async function markWizardProgressSubmitted(
  params: MarkWizardProgressSubmittedParams,
): Promise<{ error: { message: string } | null }> {
  const { progressId, wizardType, data, accountId, contactId, leadId, offerId, serviceDeliveryId } = params
  const jsonData = data as unknown as Json
  return progressId
    ? await supabaseAdmin
        .from("wizard_progress")
        .update({ data: jsonData, status: "submitted", updated_at: new Date().toISOString() })
        .eq("id", progressId)
    : await supabaseAdmin
        .from("wizard_progress")
        .insert({
          wizard_type: wizardType,
          data: jsonData,
          account_id: accountId || null,
          contact_id: contactId || null,
          lead_id: leadId || null,
          offer_id: offerId || null,
          service_delivery_id: serviceDeliveryId ?? null,
          status: "submitted",
          current_step: 99,
        })
}

// ─── One draft per wizard, even when two saves race ───────────────────────────────────────────────────────────────────
//
// The portal wizard saves its draft on step changes and on a timer. Two saves can leave the browser before the first answer
// carries the new row's id back, and each one used to create its OWN draft row (live finding, Company Closure Part C: two rows
// 0.34 s apart for one closure; the older one stayed "in progress" at step 1 forever and the CRM showed two "In Progress" cards
// after the wizard was sent). There is no database rule behind it, so it is closed here: reuse an open draft of the same wizard,
// and after inserting check that mine is the OLDEST — if not, remove mine and hand back the older one. Both racing requests reach
// the same answer, so exactly one row survives.

export interface WizardProgressKey {
  wizardType: string
  accountId: string | null
  contactId: string | null
  leadId: string | null
  offerId: string | null
  serviceDeliveryId: string | null
}

/** Pure: of the open drafts of one wizard, the id that survives — the oldest (ties broken by id so both racers agree). */
export function survivingWizardRowId(rows: ReadonlyArray<{ id: string; created_at: string | null }>): string | null {
  if (rows.length === 0) return null
  const sorted = [...rows].sort((a, b) => {
    const ta = a.created_at ?? ""
    const tb = b.created_at ?? ""
    if (ta !== tb) return ta < tb ? -1 : 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  return sorted[0].id
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the key columns are matched dynamically (null-safe), which trips TS2589 on the typed builder
function openDraftsQuery(key: WizardProgressKey): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = supabaseAdmin.from("wizard_progress").select("id, created_at").eq("wizard_type", key.wizardType).eq("status", "in_progress")
  const cols: Array<[string, string | null]> = [
    ["account_id", key.accountId],
    ["contact_id", key.contactId],
    ["lead_id", key.leadId],
    ["offer_id", key.offerId],
    ["service_delivery_id", key.serviceDeliveryId],
  ]
  for (const [col, val] of cols) q = val ? q.eq(col, val) : q.is(col, null)
  return q.order("created_at", { ascending: true }).order("id", { ascending: true })
}

export async function createOrReuseWizardProgress(
  key: WizardProgressKey,
  fields: { currentStep: number; data: Record<string, unknown> },
): Promise<{ id: string; created: boolean }> {
  // A reused draft takes the answers this save carried (they are the client's latest), so nothing typed is lost to the dedupe.
  const refresh = async (id: string) => {
    const { error } = await supabaseAdmin
      .from("wizard_progress")
      .update({ current_step: fields.currentStep, data: fields.data as unknown as Json, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "in_progress")
    if (error) throw new Error(error.message)
  }

  const { data: existing, error: exErr } = await openDraftsQuery(key)
  if (exErr) throw new Error(exErr.message)
  const oldest = survivingWizardRowId((existing ?? []) as Array<{ id: string; created_at: string | null }>)
  if (oldest) {
    await refresh(oldest)
    return { id: oldest, created: false }
  }

  const { data: created, error } = await supabaseAdmin
    .from("wizard_progress")
    .insert({
      wizard_type: key.wizardType,
      current_step: fields.currentStep,
      data: fields.data as unknown as Json,
      account_id: key.accountId,
      contact_id: key.contactId,
      lead_id: key.leadId,
      offer_id: key.offerId,
      service_delivery_id: key.serviceDeliveryId,
      status: "in_progress",
    })
    .select("id")
    .single()
  if (error) throw error

  // A racing request may have inserted too: keep the oldest, drop mine (its answers move onto the survivor).
  const { data: after, error: afterErr } = await openDraftsQuery(key)
  if (!afterErr) {
    const survivor = survivingWizardRowId((after ?? []) as Array<{ id: string; created_at: string | null }>)
    if (survivor && survivor !== created.id) {
      await supabaseAdmin.from("wizard_progress").delete().eq("id", created.id).eq("status", "in_progress")
      await refresh(survivor)
      return { id: survivor, created: false }
    }
  }
  return { id: created.id, created: true }
}

/**
 * Pure, for the CRM's "Client Wizard Submissions" card: an open draft that an already-SENT wizard of the same kind came after is
 * just the leftover twin of that wizard (see above) and is not listed — otherwise the card read "In Progress" twice after one send.
 * A draft started AFTER the sent one (the client opened the wizard again) is newer and is still shown.
 */
export function dropSupersededDrafts<T extends { status: string; wizard_type: string; updated_at: string }>(entries: readonly T[]): T[] {
  const latestSent = new Map<string, string>()
  for (const e of entries) {
    if (e.status !== "submitted") continue
    const prev = latestSent.get(e.wizard_type)
    if (!prev || e.updated_at > prev) latestSent.set(e.wizard_type, e.updated_at)
  }
  return entries.filter((e) => {
    if (e.status !== "in_progress") return true
    const sentAt = latestSent.get(e.wizard_type)
    return !(sentAt && sentAt >= e.updated_at)
  })
}
