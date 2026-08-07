/**
 * Renewal problem proposals — the "diagnose → propose" layer of the
 * Compliance Truth Calendar (plan 89c951a7, Antonio's flag/one-click ruling).
 *
 * For every problem verdict the engine emits, this module produces a
 * plain-English proposal Luca can read on the flag card, and — where the fix
 * is a pure RECORD repair — a one-click auto-fix with ABSOLUTE from→to
 * values so the apply endpoint can revalidate against a live recompute and
 * write with a checked update (.eq(col, from)). Never a relative "+1 year at
 * apply time": if the record changed since the card rendered, the fix must
 * fail loudly, not compound.
 *
 * Safety tiers (Antonio's rulings d/e — evaluate the ISSUE, never bulk-fix):
 *  - safe: record-only repair, provably corroborated (one-click for Luca)
 *  - confirm: needs Luca to confirm a judgment (derived date, real filing)
 *  - antonio_only: money decisions (unpaid holds) — Antonio unlocks/gifts
 */

import { plusOneYear, deriveRenewalDates } from "@/lib/operations/renewal-dates"
import type { ObligationKind, ObligationVerdict } from "@/lib/operations/renewal-status"
import type { LoadedRenewalAccount } from "@/lib/operations/renewal-status-loader"

export type ProposalAction =
  | "roll_forward_date"    // stale record, cycle corroborated → +1yr repair
  | "verify_filing"        // past date, nothing recorded → human check
  | "review_unpaid"        // money hold → Antonio decides
  | "derive_missing_date"  // NULL date, derivable from intake rules
  | "fix_account_fields"   // NULL date/state, not derivable → manual data fix

export type ProposalTier = "safe" | "confirm" | "antonio_only"

export interface RenewalAutoFix {
  column: "ra_renewal_date" | "annual_report_due_date"
  /** Value the column MUST still hold at apply time (checked write). */
  from: string | null
  to: string
}

export interface RenewalFixProposal {
  accountId: string
  companyName: string
  obligation: ObligationKind
  status: ObligationVerdict["status"]
  action: ProposalAction
  tier: ProposalTier
  /** One-line card title, plain English. */
  summary: string
  /** The full explanation: the problem, the evidence, what the fix changes. */
  details: string
  autoFix: RenewalAutoFix | null
}

const LABEL: Record<ObligationKind, string> = {
  ra_renewal: "Registered Agent renewal",
  annual_report: "Annual report",
}

const COLUMN: Record<ObligationKind, RenewalAutoFix["column"]> = {
  ra_renewal: "ra_renewal_date",
  annual_report: "annual_report_due_date",
}

function closingNote(loaded: LoadedRenewalAccount): string {
  return loaded.status.closing
    ? " NOTE: this company has an active closure — the row stays visible until the closure procedure completes."
    : ""
}

function proposeForVerdict(
  loaded: LoadedRenewalAccount,
  kind: ObligationKind,
  currentYear: number | undefined,
): RenewalFixProposal | null {
  const verdict = kind === "ra_renewal" ? loaded.status.ra : loaded.status.annualReport
  const a = loaded.account
  const label = LABEL[kind]
  const base = {
    accountId: a.id,
    companyName: a.company_name,
    obligation: kind,
    status: verdict.status,
  }

  switch (verdict.status) {
    case "on_hold_unpaid":
      return {
        ...base,
        action: "review_unpaid",
        tier: "antonio_only",
        summary: `${label} held — unpaid invoice`,
        details: `${verdict.cause} Antonio decides: collect the payment, or unlock the renewal as a gift from the account page.${closingNote(loaded)}`,
        autoFix: null,
      }

    case "overdue": {
      if (verdict.evidence.completedSdForCurrentCycle && verdict.date) {
        const to = plusOneYear(verdict.date)
        return {
          ...base,
          action: "roll_forward_date",
          tier: "safe",
          summary: `${label} record never rolled forward`,
          details: `${verdict.cause} One-click fix: move the recorded date from ${verdict.date} to ${to}. This repairs OUR record only — no state filing and no client contact happens.${closingNote(loaded)}`,
          autoFix: { column: COLUMN[kind], from: verdict.date, to },
        }
      }
      return {
        ...base,
        action: "verify_filing",
        tier: "confirm",
        summary: `${label} past due — verify whether it was filed`,
        details: `${verdict.cause} If it WAS filed, use Mark Filed with the real filing year (that rolls the record and stores the receipt). If it was NOT filed, the renewal work must be performed — do not just change the date.${closingNote(loaded)}`,
        autoFix: null,
      }
    }

    case "missing_data": {
      // Try the shipped derivation rules — only when the intake is known.
      if (loaded.intake) {
        const fills = deriveRenewalDates({
          currentYear,
          intake: loaded.intake,
          formation_date: a.formation_date,
          ra_switch_date: a.ra_switch_date,
          client_since: a.client_since,
          state_of_formation: a.state_of_formation,
          existing: {
            ra_renewal_date: a.ra_renewal_date,
            annual_report_due_date: a.annual_report_due_date,
            cmra_renewal_date: "derived-elsewhere", // non-null → never re-derived here
          },
        })
        const derived = kind === "ra_renewal" ? fills.ra_renewal_date : fills.annual_report_due_date
        if (derived) {
          return {
            ...base,
            action: "derive_missing_date",
            tier: "confirm",
            summary: `${label} date missing — can be derived`,
            details: `${verdict.cause} Derived ${derived} from the ${loaded.intake === "formation" ? "formation anniversary" : "onboarding RA-switch date"} per the standard rules. Confirm to set it — the company becomes visible to reminders again.${
              kind === "annual_report"
                ? " ⚠ Before confirming: check whether THIS year's report was actually filed — the derived date is next year's cycle, and confirming it marks the company current (compliance-auditor, council 2026-08-06)."
                : ""
            }${closingNote(loaded)}`,
            autoFix: { column: COLUMN[kind], from: null, to: derived },
          }
        }
      }
      return {
        ...base,
        action: "fix_account_fields",
        tier: "confirm",
        summary: `${label} needs account data fixed`,
        details: `${verdict.cause} This cannot be fixed automatically — the account is missing the fields the rules derive from (formation/onboarding dates or the state). Fix the account fields, then the date can be derived.${closingNote(loaded)}`,
        autoFix: null,
      }
    }

    default:
      return null // renewed / upcoming / not_applicable — no problem card
  }
}

/**
 * All problem proposals for one loaded company. Companies off the calendar
 * (One-Time / test / internal) never get cards — ruling (b).
 */
export function proposeRenewalFixes(
  loaded: LoadedRenewalAccount,
  opts: { today?: string } = {},
): RenewalFixProposal[] {
  if (!loaded.status.onCalendar) return []
  const currentYear = opts.today ? parseInt(opts.today.split("-")[0], 10) : undefined
  const out: RenewalFixProposal[] = []
  for (const kind of ["ra_renewal", "annual_report"] as const) {
    const p = proposeForVerdict(loaded, kind, currentYear)
    if (p) out.push(p)
  }
  return out
}
