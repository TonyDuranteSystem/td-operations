import { supabaseAdmin } from "@/lib/supabase-admin"

/**
 * Set a newly-active company's initial compliance renewal dates (CMRA + state
 * annual report) when they are not already set. Idempotent — only fills blanks.
 *
 * Flexible Formation model (2026-05-28): formation now COMPLETES at EIN received
 * instead of advancing into the retired "Post-Formation + Banking" stage, so this
 * logic — which previously fired as a stage-advance side-effect in
 * lib/service-delivery.ts (#12) — must run at the EIN-completion moment instead.
 * Replicated here (not refactored out of the shared advanceServiceDelivery path)
 * to avoid touching shared code other flows depend on. The #12 block stays as-is
 * for any legacy advance; this is the path new formations use.
 *
 * Returns human-readable side-effect notes for the caller's audit log.
 */
export async function applyInitialRenewalDates(accountId: string): Promise<string[]> {
  const notes: string[] = []
  try {
    const { data: acct } = await supabaseAdmin
      .from("accounts")
      .select("cmra_renewal_date, annual_report_due_date, state_of_formation, formation_date")
      .eq("id", accountId)
      .single()
    if (!acct) return notes

    const renewals: Record<string, unknown> = {}
    const currentYear = new Date().getFullYear()

    if (!acct.cmra_renewal_date) {
      renewals.cmra_renewal_date = `${currentYear}-12-31`
    }
    if (!acct.annual_report_due_date) {
      const st = (acct.state_of_formation || "")
        .toUpperCase()
        .replace("NEW MEXICO", "NM")
        .replace("WYOMING", "WY")
        .replace("FLORIDA", "FL")
        .replace("DELAWARE", "DE")
      if (st === "FL") renewals.annual_report_due_date = `${currentYear + 1}-05-01`
      else if (st === "DE") renewals.annual_report_due_date = `${currentYear + 1}-06-01`
      else if (st === "WY" && acct.formation_date) {
        const month = String(acct.formation_date).slice(5, 7)
        renewals.annual_report_due_date = `${currentYear + 1}-${month}-01`
      }
    }

    if (Object.keys(renewals).length > 0) {
      renewals.updated_at = new Date().toISOString()
      const { error } = await supabaseAdmin
        // eslint-disable-next-line no-restricted-syntax -- mirrors lib/service-delivery.ts #12 (deferred migration, dev_task 7ebb1e0c)
        .from("accounts")
        .update(renewals as never)
        .eq("id", accountId)
      if (error) {
        notes.push(`Renewal dates failed: ${error.message}`)
      } else {
        const datesList = Object.entries(renewals)
          .filter(([k]) => k !== "updated_at")
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")
        notes.push(`Renewal dates set: ${datesList}`)
      }
    }
  } catch (e) {
    notes.push(`Renewal dates failed: ${e instanceof Error ? e.message : "unknown"}`)
  }
  return notes
}
