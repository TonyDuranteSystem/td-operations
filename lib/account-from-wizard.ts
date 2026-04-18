/**
 * Shared account creation utility for wizard handlers.
 * Creates an account from wizard-submitted data, links it to the contact,
 * and backfills account_id on contact-only payments/invoices.
 *
 * Used by: onboarding-setup, tax-return-intake
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { normalizeEIN } from "@/lib/jobs/validation"

interface AccountFromWizardParams {
  contactId: string
  companyName: string
  entityType: string // "SMLLC" or "MMLLC"
  stateOfFormation?: string | null
  ein?: string | null
  formationDate?: string | null
  accountType?: string // "Client" | "One-Time" — default "Client"
}

interface AccountFromWizardResult {
  accountId: string | null
  created: boolean
  backfilled: { invoices: number; payments: number }
  error?: string
}

export async function createAccountFromWizard(
  params: AccountFromWizardParams
): Promise<AccountFromWizardResult> {
  const {
    contactId,
    companyName,
    entityType,
    stateOfFormation,
    ein,
    formationDate,
    accountType = "Client",
  } = params

  // 1. Check if account already exists for this company + contact
  const { data: existingLinks } = await supabaseAdmin
    .from("account_contacts")
    .select("account_id, accounts!inner(id, company_name)")
    .eq("contact_id", contactId)

  const existingAccount = existingLinks?.find(
    (link: Record<string, unknown>) => {
      const acct = link.accounts as { company_name?: string } | null
      return acct?.company_name?.toLowerCase() === companyName.toLowerCase()
    }
  )

  if (existingAccount) {
    return {
      accountId: existingAccount.account_id as string,
      created: false,
      backfilled: { invoices: 0, payments: 0 },
    }
  }

  // 2. Create account
  const entityDisplay = entityType === "MMLLC" ? "Multi Member LLC" : "Single Member LLC"

  // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
  const { data: newAcct, error: acctErr } = await supabaseAdmin
    .from("accounts")
    .insert({
      company_name: companyName,
      entity_type: entityDisplay,
      state_of_formation: stateOfFormation || null,
      account_type: accountType,
      status: "Active",
      // Persist EIN in canonical XX-XXXXXXX format. normalizeEIN() accepts
      // bare 9-digit input (e.g. the 334119609 Luca Gallacci typed) and
      // returns the dashed form. Returns null for anything not exactly 9
      // digits — in which case we keep null so downstream forms
      // (1120 / 5472 / SS-4) don't inherit garbage.
      ein_number: normalizeEIN(ein),
      formation_date: formationDate ? String(formationDate) : null,
    })
    .select("id")
    .single()

  if (acctErr || !newAcct) {
    return {
      accountId: null,
      created: false,
      backfilled: { invoices: 0, payments: 0 },
      error: acctErr?.message || "Account insert failed",
    }
  }

  // 3. Link contact → account
  const { error: linkErr } = await supabaseAdmin
    .from("account_contacts")
    .insert({ account_id: newAcct.id, contact_id: contactId, role: "Owner" })

  if (linkErr && !linkErr.message.includes("duplicate")) {
    console.warn(`[account-from-wizard] Link error (non-fatal): ${linkErr.message}`)
  }

  // 4. Backfill account_id on contact-only payments/invoices
  const { count: backfilledInv } = await supabaseAdmin
    .from("client_invoices")
    .update({ account_id: newAcct.id, updated_at: new Date().toISOString() })
    .eq("contact_id", contactId)
    .is("account_id", null)

  // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
  const { count: backfilledPay } = await supabaseAdmin
    .from("payments")
    .update({ account_id: newAcct.id, updated_at: new Date().toISOString() })
    .eq("contact_id", contactId)
    .is("account_id", null)

  return {
    accountId: newAcct.id,
    created: true,
    backfilled: {
      invoices: backfilledInv ?? 0,
      payments: backfilledPay ?? 0,
    },
  }
}
