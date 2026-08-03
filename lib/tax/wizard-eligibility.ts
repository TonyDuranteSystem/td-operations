/**
 * Tax Wizard Eligibility — the single source of truth for "is this client's
 * tax wizard open, and for which tax year?".
 *
 * Born from the PTBT Holding incident (2026-07-16, dev job 8cc8e1c8): a
 * company formed 2026-03-02 self-served the tax wizard through the portal
 * home card + the ?type=tax forced link and its submission was silently
 * stamped tax_year=2025 by a DB column default. Four surfaces each decided
 * "wizard open" independently; the weakest gate won.
 *
 * Every consumer — the home action cards, the wizard page (derived, forced
 * AND offer-fallback paths), and the submit route — MUST call this module.
 * The submit route is the gate that actually matters: UI checks are
 * convenience, the server check is the guarantee.
 *
 * Decision rules (council-approved plan, 2026-07-16):
 *  - The eligibility token for a NEW submission is an OPEN tax_returns row
 *    (data_received=false), joined by account_id — never company_name.
 *    Its tax_year is pinned end-to-end; no caller may ever derive a year
 *    from a calendar or a column default.
 *  - A company formed AFTER the tax year has no filing requirement: strict
 *    formation_year <= tax_year. (Do NOT reuse firstYearCoherent — its >=
 *    direction answers "can a prior return exist", the opposite question.)
 *    A NULL formation_date passes: staff's deliberately-opened row is the
 *    stronger signal.
 *  - SD stage gates by NAME per service type (never stage_order — the
 *    One-Time pipeline's orders differ 10x from the bundle's). Unknown or
 *    NULL stages are CLOSED (fail-closed; the old deny-list let unknown
 *    stages fall through to open).
 *  - The review loop owns any account with a live submission for the target
 *    year: client-editable states resolve to 'review' (edits UPDATE that
 *    submission row); ONLY under_review and confirmed are locked. `resubmitted`
 *    was locked here until 2026-08-03 and should not be again — it means the
 *    CLIENT handed data back with no staff review started, and locking it shut
 *    five accounts out of both this wizard and the tax-financials screen.
 *    Stages 45-49 are deliberately NOT in the open allow-list — the SD parks
 *    at "Data Submitted" for the whole review, so putting them there would
 *    re-open the wizard mid-review.
 *  - A NEWER open tax year outranks an older year's lingering editable
 *    submission (next-season unlock): target year = the OLDEST open row
 *    (back-filing collects oldest first), and review mode only triggers for
 *    a submission matching the target year — or, with no open rows at all,
 *    the latest submission still in its review loop.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { isClientEditable, isReviewStatus, type ReviewStatus } from "@/lib/tax/review-status"

export type TaxWizardMode = "company_info" | "open" | "review" | "closed"

export type TaxWizardClosedReason =
  | "no_tax_service"          // no active Tax Return SD at all
  | "no_tax_return_open"      // no open tax_returns row — season not opened by staff
  | "pre_wizard_stage"        // SD not yet at a wizard-open stage (e.g. awaiting 2nd installment)
  | "formation_after_tax_year" // company did not exist in the open row's tax year
  | "under_review"            // staff actively reviewing — locked
  | "confirmed"               // review confirmed — locked

export interface TaxWizardEligibility {
  mode: TaxWizardMode
  /** Pinned tax year: the open row's year ('open') or the submission's stored year ('review'). */
  taxYear: number | null
  /** The open tax_returns row backing an 'open' resolution. */
  taxReturnId: string | null
  /** The submission row a 'review'-mode edit must UPDATE (never a token upsert). */
  submissionId: string | null
  reason: TaxWizardClosedReason | null
}

/** Named wizard-open stage sets per service type. Order-based checks are
 * forbidden: bundle orders are 10/20/30/40/45…; One-Time orders are 0-7. */
const OPEN_STAGES_BY_SERVICE_TYPE: Record<string, ReadonlySet<string>> = {
  "Tax Return": new Set(["Wizard Available"]),
  // Legacy service-type alias still matched by the submit handler.
  "Tax Return Filing": new Set(["Wizard Available"]),
  // One-Time has no installment split: the wizard is open from payment.
  "Tax Return One-Time": new Set(["Payment Received", "Wizard Available"]),
}

export const TAX_WIZARD_SERVICE_TYPES = Object.keys(OPEN_STAGES_BY_SERVICE_TYPE)

/** The standalone-intake stage: company data not yet collected — the client
 * gets the company_info wizard, not the tax wizard. */
const COMPANY_INFO_STAGE = "Company Data Pending"

export interface EligibilitySd {
  service_type: string
  stage: string | null
}

export interface EligibilityOpenReturn {
  id: string
  tax_year: number
}

export interface EligibilitySubmission {
  id: string
  tax_year: number
  review_status: string | null
  created_at: string
}

export interface TaxWizardEligibilityInputs {
  /** Active tax-family SDs for the subject (account-scoped, or contact-scoped when no account). */
  sds: EligibilitySd[]
  /** Open tax_returns rows (data_received=false) for the account, ANY order. */
  openReturns: EligibilityOpenReturn[]
  /** All tax_return_submissions for the account, ANY order. */
  submissions: EligibilitySubmission[]
  /** accounts.formation_date (ISO date string) or null. */
  formationDate: string | null
  /** True when the subject has no materialized account yet (contact-scoped SD). */
  accountless: boolean
}

function formationYearOf(formationDate: string | null): number | null {
  if (!formationDate) return null
  const y = new Date(formationDate).getFullYear()
  return Number.isFinite(y) ? y : null
}

function latestOf(subs: EligibilitySubmission[]): EligibilitySubmission | null {
  if (subs.length === 0) return null
  return subs.reduce((a, b) => (a.created_at >= b.created_at ? a : b))
}

function closed(reason: TaxWizardClosedReason): TaxWizardEligibility {
  return { mode: "closed", taxYear: null, taxReturnId: null, submissionId: null, reason }
}

function reviewLockFor(status: ReviewStatus): TaxWizardClosedReason {
  return status === "confirmed" ? "confirmed" : "under_review"
}

/**
 * Pure decision core — no DB. Unit-tested exhaustively; the async wrapper
 * below only loads the inputs.
 */
export function decideTaxWizardEligibility(inputs: TaxWizardEligibilityInputs): TaxWizardEligibility {
  const { sds, openReturns, submissions, accountless } = inputs

  if (sds.length === 0) return closed("no_tax_service")

  // Standalone/company-not-materialized intake: the tax wizard is not the
  // next step — company_info is. Contact-scoped SDs (account_id NULL until
  // company_info completes) and the explicit stage both route there.
  if (accountless || sds.some(sd => sd.stage === COMPANY_INFO_STAGE)) {
    return { mode: "company_info", taxYear: null, taxReturnId: null, submissionId: null, reason: null }
  }

  // Target year: the OLDEST open row (back-filing collects oldest first).
  const sortedOpen = [...openReturns].sort((a, b) => a.tax_year - b.tax_year)
  const target = sortedOpen[0] ?? null

  // ── Review loop owns the answer when a live submission exists ──
  // With an open target year: only a submission FOR that year counts (a
  // lingering editable submission from a previous season must not block the
  // new year — next-season unlock).
  // With no open rows: the latest submission overall (the normal post-submit
  // state — data_received flips true at confirm-time system-wide, and the
  // 9 live review-loop clients verified 2026-07-16 all lack an open row).
  const reviewCandidate = target
    ? latestOf(submissions.filter(s => s.tax_year === target.tax_year))
    : latestOf(submissions)

  if (reviewCandidate) {
    const rs = isReviewStatus(reviewCandidate.review_status) ? reviewCandidate.review_status : null
    if (rs !== null) {
      if (isClientEditable(rs)) {
        return {
          mode: "review",
          taxYear: reviewCandidate.tax_year,
          taxReturnId: target?.id ?? null,
          submissionId: reviewCandidate.id,
          reason: null,
        }
      }
      return closed(reviewLockFor(rs))
    }
    // review_status NULL (pre-Slice-2 legacy row): while an open row exists
    // the client may still be mid-collection — fall through to the 'open'
    // check below (a fresh submit supersedes the legacy row). With no open
    // row the collection is done from staff's side: closed.
    if (!target) return closed("no_tax_return_open")
  }

  if (!target) return closed("no_tax_return_open")

  // ── Formation guard: no filing requirement for a year the company didn't exist ──
  const fy = formationYearOf(inputs.formationDate)
  if (fy !== null && fy > target.tax_year) return closed("formation_after_tax_year")

  // ── Stage gate: named allow-list per service type, fail-closed ──
  const stageOpen = sds.some(sd => {
    const allowed = OPEN_STAGES_BY_SERVICE_TYPE[sd.service_type]
    return allowed !== undefined && sd.stage !== null && allowed.has(sd.stage)
  })
  if (!stageOpen) return closed("pre_wizard_stage")

  return { mode: "open", taxYear: target.tax_year, taxReturnId: target.id, submissionId: null, reason: null }
}

export interface ResolveTaxWizardParams {
  accountId?: string | null
  contactId?: string | null
}

/**
 * Load the inputs and decide. Pass BOTH ids when available: standalone tax
 * clients carry their SD on the contact (account_id NULL) until company_info
 * materializes the account — an account-only lookup would lock them out.
 */
export async function resolveTaxWizardEligibility(params: ResolveTaxWizardParams): Promise<TaxWizardEligibility> {
  const accountId = params.accountId || null
  const contactId = params.contactId || null
  if (!accountId && !contactId) return closed("no_tax_service")

  // SDs: account-scoped first; contact-scoped (account_id NULL) as the
  // standalone-intake fallback.
  let sds: EligibilitySd[] = []
  if (accountId) {
    const { data } = await supabaseAdmin
      .from("service_deliveries")
      .select("service_type, stage")
      .eq("account_id", accountId)
      .eq("status", "active")
      .in("service_type", TAX_WIZARD_SERVICE_TYPES)
      .limit(10)
    sds = (data ?? []) as EligibilitySd[]
  }
  let accountless = false
  if (sds.length === 0 && contactId) {
    const { data } = await supabaseAdmin
      .from("service_deliveries")
      .select("service_type, stage")
      .eq("contact_id", contactId)
      .is("account_id", null)
      .eq("status", "active")
      .in("service_type", TAX_WIZARD_SERVICE_TYPES)
      .limit(10)
    sds = (data ?? []) as EligibilitySd[]
    accountless = sds.length > 0
  }

  let openReturns: EligibilityOpenReturn[] = []
  let submissions: EligibilitySubmission[] = []
  let formationDate: string | null = null
  if (accountId) {
    const [openRes, subRes, acctRes] = await Promise.all([
      supabaseAdmin
        .from("tax_returns")
        .select("id, tax_year")
        .eq("account_id", accountId)
        .eq("data_received", false),
      supabaseAdmin
        .from("tax_return_submissions")
        .select("id, tax_year, review_status, created_at")
        .eq("account_id", accountId),
      supabaseAdmin
        .from("accounts")
        .select("formation_date")
        .eq("id", accountId)
        .maybeSingle(),
    ])
    openReturns = (openRes.data ?? []) as EligibilityOpenReturn[]
    submissions = (subRes.data ?? []) as EligibilitySubmission[]
    formationDate = (acctRes.data?.formation_date as string | null) ?? null
  }

  return decideTaxWizardEligibility({ sds, openReturns, submissions, formationDate, accountless })
}

/**
 * Should the wizard PAGE render the tax wizard surface at all? The locked
 * review states (under_review / confirmed) keep a READ-ONLY view of the
 * submitted data — only submitting is gated (the page's isLocked machinery
 * handles the lock; the submit route rejects regardless).
 */
export function taxWizardSurfaceVisible(e: TaxWizardEligibility): boolean {
  return (
    e.mode === "open" ||
    e.mode === "review" ||
    (e.mode === "closed" && (e.reason === "under_review" || e.reason === "confirmed"))
  )
}

/** Human/actionable copy per closed reason, EN + IT, for R099-compliant
 * error bodies and UI states. Kept here so every surface says the same thing. */
export const CLOSED_REASON_COPY: Record<TaxWizardClosedReason, { en: string; it: string }> = {
  no_tax_service: {
    en: "There is no tax return service on your account. If you believe this is wrong, please message us from the portal chat.",
    it: "Non risulta un servizio di dichiarazione dei redditi sul tuo account. Se pensi sia un errore, scrivici dalla chat del portale.",
  },
  no_tax_return_open: {
    en: "Your tax questionnaire isn't open yet — we'll notify you when it's time to submit your information.",
    it: "Il tuo questionario fiscale non è ancora aperto — ti avviseremo quando sarà il momento di inviare le informazioni.",
  },
  pre_wizard_stage: {
    en: "Your tax questionnaire isn't open yet — it unlocks after your tax return service reaches the data-collection step.",
    it: "Il tuo questionario fiscale non è ancora aperto — si sblocca quando il servizio dichiarazione raggiunge la fase di raccolta dati.",
  },
  formation_after_tax_year: {
    en: "Your company was formed after this tax year, so no return is due for it. Your first tax questionnaire opens next season.",
    it: "La tua società è stata costituita dopo questo anno fiscale, quindi non è dovuta alcuna dichiarazione. Il primo questionario si aprirà la prossima stagione.",
  },
  under_review: {
    en: "Our team is reviewing your submitted information — editing is locked until the review finishes.",
    it: "Il nostro team sta esaminando le informazioni inviate — le modifiche sono bloccate fino alla fine della revisione.",
  },
  confirmed: {
    en: "Your tax information is confirmed and locked. Message us from the portal chat if something needs to change.",
    it: "Le tue informazioni fiscali sono confermate e bloccate. Scrivici dalla chat del portale se serve una modifica.",
  },
}
