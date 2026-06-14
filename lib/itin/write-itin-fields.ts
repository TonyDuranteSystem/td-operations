import { supabaseAdmin } from "@/lib/supabase-admin"
import { calcITINRenewalDate } from "./renewal-utils"

/**
 * Write ITIN fields to a contact, auto-calculating itin_renewal_date from itin_issue_date.
 * Single write path for all callers — OCR routes, wizard handlers, manual CRM edits.
 */
export async function writeITINFields(
  contactId: string,
  fields: {
    itin_number?: string | null
    itin_issue_date?: string | null
  },
): Promise<{ itin_renewal_date: string | null }> {
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }

  if (fields.itin_number !== undefined) update.itin_number = fields.itin_number
  if (fields.itin_issue_date !== undefined) {
    update.itin_issue_date = fields.itin_issue_date
    const renewalDate = calcITINRenewalDate(fields.itin_issue_date)
    update.itin_renewal_date = renewalDate ? renewalDate.toISOString().split("T")[0] : null
  }

  const dataKeys = Object.keys(update).filter((k) => k !== "updated_at")
  if (dataKeys.length === 0) return { itin_renewal_date: null }

  // eslint-disable-next-line no-restricted-syntax -- canonical ITIN write helper; single write path for all callers
  const { error } = await supabaseAdmin.from("contacts").update(update).eq("id", contactId)
  if (error) throw new Error(`writeITINFields failed: ${error.message}`)

  const renewalDate =
    fields.itin_issue_date !== undefined ? calcITINRenewalDate(fields.itin_issue_date) : null

  return {
    itin_renewal_date: renewalDate ? renewalDate.toISOString().split("T")[0] : null,
  }
}
