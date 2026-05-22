/**
 * Create ITIN service deliveries from a formation/onboarding wizard submission.
 *
 * Why this exists (dev_task fcf5e254): when ITIN is bundled into a formation or
 * onboarding offer, the activation flow (activate-service.ts) skips ALL bundled
 * pipelines for formation/onboarding — Company Formation and Banking are
 * deferred to company creation. ITIN is personal (the individual's tax ID,
 * ~2 months) and must NOT wait for the company. It starts when the client
 * submits the formation/onboarding wizard and marks who applies.
 *
 * The wizard collects an "applies for ITIN" flag per person:
 *   - owner_needs_itin                (owner / primary contact)
 *   - member_{i}_member_needs_itin    (each additional MMLLC member)
 *
 * For every flagged person we create a contact-scoped ITIN SD (account_id=null,
 * enforced by createSD per the Phase 1 ITIN rule). Creating the SD is the
 * trigger: the portal then shows the ITIN wizard for that contact, and
 * completing it runs the existing ITIN auto-chain (itin-form-completed:
 * W-7/1040-NR generation, task for Luca, etc.). We do NOT rebuild ITIN here.
 *
 * Data-driven gate: only runs when "ITIN" is tagged `start_at_wizard` in the
 * services catalog (getStartAtWizardServiceTypes). Flip the tag to disable.
 *
 * Idempotent: a person who already has an ITIN SD for this offer token is
 * skipped. New member contacts are find-or-created by email and stamped with
 * `lead_id` (write-once origin); existing contacts are reused and NEVER
 * re-stamped (an existing client keeps their own origin).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { createSD } from "@/lib/operations/service-delivery"
import { getStartAtWizardServiceTypes } from "@/lib/services"
import { extractMembersFromWizardData } from "@/lib/utils/wizard-members"

export interface ItinFromWizardParams {
  /** Owner / primary contact — already exists (created at activation). */
  contactId: string
  /** Originating lead, used to stamp lead_id on NEWLY created member contacts. */
  leadId: string | null
  /** Wizard submitted_data (flat keys). */
  submitted: Record<string, unknown>
  /** Offer token — idempotency key + traceability in SD notes. */
  offerToken: string | null
}

export interface ItinFromWizardPerson {
  name: string
  contactId: string
  status: "created" | "existing" | "error"
  detail?: string
}

export interface ItinFromWizardResult {
  created: number
  skipped: number
  people: ItinFromWizardPerson[]
}

function truthy(v: unknown): boolean {
  if (v === true) return true
  if (typeof v === "string") return /^(true|yes|si|sì|1|on)$/i.test(v.trim())
  if (typeof v === "number") return v === 1
  return false
}

export async function createItinDeliveriesFromWizard(
  params: ItinFromWizardParams,
): Promise<ItinFromWizardResult> {
  const result: ItinFromWizardResult = { created: 0, skipped: 0, people: [] }
  const { contactId, leadId, submitted, offerToken } = params

  // Gate: ITIN must be an active start-at-wizard service in the catalog.
  const startAtWizard = await getStartAtWizardServiceTypes()
  if (!startAtWizard.includes("ITIN")) return result

  // ── Build the list of people who applied for an ITIN ──
  type Applicant = { name: string; contactId: string | null; email: string | null }
  const applicants: Applicant[] = []

  if (truthy(submitted.owner_needs_itin)) {
    const ownerName =
      [submitted.owner_first_name, submitted.owner_last_name]
        .filter(Boolean)
        .map(String)
        .join(" ")
        .trim() || "Owner"
    applicants.push({
      name: ownerName,
      contactId,
      email: submitted.owner_email ? String(submitted.owner_email) : null,
    })
  }

  for (const m of extractMembersFromWizardData(submitted)) {
    if (m.member_type !== "individual") continue
    if (!m.member_needs_itin) continue
    const name =
      [m.member_first_name, m.member_last_name].filter(Boolean).join(" ") ||
      m.member_email ||
      "Member"
    applicants.push({ name, contactId: null, email: m.member_email })
  }

  if (applicants.length === 0) return result

  // First-stage auto_tasks for ITIN (mirror activate-service's standalone path
  // so staff get the same task they'd get for a standalone ITIN purchase).
  const { data: itinStages } = await supabaseAdmin
    .from("pipeline_stages")
    .select("stage_name, stage_order, auto_tasks")
    .eq("service_type", "ITIN")
    .order("stage_order", { ascending: true })
    .limit(1)
  const firstStage = itinStages?.[0] as
    | { stage_name: string; stage_order: number; auto_tasks: unknown }
    | undefined
  const autoTasks = Array.isArray(firstStage?.auto_tasks)
    ? (firstStage.auto_tasks as Array<{
        title: string
        assigned_to?: string
        category?: string
        priority?: string
      }>)
    : []

  for (const a of applicants) {
    try {
      // Resolve contact: owner already has one; member find-or-create by email.
      let personContactId = a.contactId
      if (!personContactId) {
        if (!a.email) {
          result.people.push({
            name: a.name,
            contactId: "",
            status: "error",
            detail: "no email — cannot find/create contact",
          })
          continue
        }
        const email = a.email.toLowerCase().trim()
        const { data: existing } = await supabaseAdmin
          .from("contacts")
          .select("id")
          .eq("email", email)
          .limit(1)
          .maybeSingle()
        if (existing) {
          // Reuse existing contact — never re-stamp lead_id (keeps their origin).
          personContactId = existing.id
        } else {
          const { data: newC } = await supabaseAdmin
            .from("contacts")
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- lead_id column lands with this feature's migration; types lag
            .insert({
              email,
              full_name: a.name,
              lead_id: leadId, // write-once origin — NEW contact only
              updated_at: new Date().toISOString(),
            } as any)
            .select("id")
            .single()
          personContactId = (newC as { id: string } | null)?.id ?? null
        }
      }
      if (!personContactId) {
        result.people.push({
          name: a.name,
          contactId: "",
          status: "error",
          detail: "could not resolve contact",
        })
        continue
      }

      // Idempotency: skip if this contact already has an ITIN SD for this offer.
      if (offerToken) {
        const { data: dup } = await supabaseAdmin
          .from("service_deliveries")
          .select("id")
          .eq("service_type", "ITIN")
          .eq("contact_id", personContactId)
          .ilike("notes", `%${offerToken}%`)
          .limit(1)
        if (dup && dup.length > 0) {
          result.skipped++
          result.people.push({ name: a.name, contactId: personContactId, status: "existing" })
          continue
        }
      }

      const sd = await createSD({
        service_type: "ITIN",
        service_name: `ITIN Application - ${a.name}`,
        account_id: null,
        contact_id: personContactId,
        notes: `Auto-created from offer ${offerToken ?? "(unknown)"} — formation/onboarding wizard (applies for ITIN)`,
      })

      // Auto-tasks from the ITIN first stage.
      for (const t of autoTasks) {
        await supabaseAdmin
          .from("tasks")
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deferred raw task insert; mirrors activate-service
          .insert({
            task_title: `[ITIN Application - ${a.name}] ${t.title}`,
            assigned_to: t.assigned_to || "Luca",
            category: (t.category || "Internal") as never,
            priority: (t.priority || "Normal") as never,
            description:
              "Auto-created on ITIN service delivery creation (formation/onboarding wizard).",
            status: "To Do",
            account_id: null,
            contact_id: personContactId,
            delivery_id: sd.id,
            stage_order: firstStage?.stage_order ?? 0,
          } as any)
      }

      result.created++
      result.people.push({ name: a.name, contactId: personContactId, status: "created" })
    } catch (e) {
      result.people.push({
        name: a.name,
        contactId: a.contactId ?? "",
        status: "error",
        detail: e instanceof Error ? e.message : String(e),
      })
    }
  }

  return result
}
