/**
 * Wizard bank-account NUMBER GATE — server-side, submit-time.
 *
 * Identity build (2026-08-13, card 4a39e0fd; counselor-verified design): the
 * wizard's uploads bypass any form-aware server (path minted, file TUS'd
 * straight to storage), so the ONLY bypass-proof enforcement point is the
 * submit route, which sees the whole declared bank list. For every declared
 * bank row whose institution is account_number-mode (per the LIVE registry),
 * the account number/last-4 (`account_label`) is REQUIRED unless the client
 * ticked the per-row "no single account number" escape (`no_number`).
 *
 * GRANDFATHER (the 13 production re-editors): a bank row identical in name to
 * one on the client's PRIOR submitted data that ALSO had no number passes with
 * a flag instead of a wall — a client re-editing an old submission is never
 * stranded by a rule that did not exist when they first submitted. New rows,
 * and old rows the client renamed, get the gate.
 *
 * PURE — registry and prior data are injected, so this is unit-testable and
 * client-safe by construction (only used server-side today).
 */

import { resolveInstitution, type InstitutionEntry } from "./bank-identity"

export interface MissingBankNumber {
  index: number
  bank: string
  /** Canonical institution name (for the client-facing message). */
  canonical: string
  /** True = passed only via the grandfather rule (flag, don't block). */
  grandfathered: boolean
}

export interface WizardBankGateResult {
  ok: boolean
  /** Rows REFUSED (missing number, not grandfathered). */
  missing: MissingBankNumber[]
  /** Rows allowed through by the grandfather rule — surface to staff, never block. */
  grandfathered: MissingBankNumber[]
}

function bankRows(data: Record<string, unknown>): Array<{ index: number; bank: string; label: string; waived: boolean }> {
  const count = Number(data["bank_accounts_count"] ?? 0)
  const rows: Array<{ index: number; bank: string; label: string; waived: boolean }> = []
  for (let i = 0; i < count; i++) {
    const bank = String(data[`bank_accounts_${i}_bank_name`] ?? "").trim()
    if (!bank) continue
    rows.push({
      index: i,
      bank,
      label: String(data[`bank_accounts_${i}_account_label`] ?? "").trim(),
      waived: String(data[`bank_accounts_${i}_no_number`] ?? "") === "1",
    })
  }
  return rows
}

export function checkWizardBankNumbers(params: {
  data: Record<string, unknown>
  registry?: InstitutionEntry[]
  /** The client's PRIOR submitted data (same account+year), when re-editing. */
  priorData?: Record<string, unknown> | null
}): WizardBankGateResult {
  const { data, registry, priorData } = params
  const missing: MissingBankNumber[] = []
  const grandfathered: MissingBankNumber[] = []

  // Prior numberless rows — the grandfather BUDGET, counted per normalized
  // bank name (bug-hunter 2026-08-13: a name-keyed SET grandfathered EVERY
  // current numberless row of that bank — a re-editor adding a SECOND Chase
  // account got both waved through numberless, silently MERGING two real
  // accounts, the exact corruption this build kills). One prior numberless
  // Chase grandfathers exactly ONE current numberless Chase; the second is
  // refused with the normal guiding message. A renamed bank is a NEW
  // declaration — the gate applies.
  const priorBudget = new Map<string, number>()
  if (priorData) {
    for (const r of bankRows(priorData)) {
      if (r.label) continue
      const k = r.bank.toLowerCase()
      priorBudget.set(k, (priorBudget.get(k) ?? 0) + 1)
    }
  }

  for (const row of bankRows(data)) {
    if (row.label || row.waived) continue
    const inst = resolveInstitution(row.bank, registry)
    if (inst.mode !== "account_number") continue
    const k = row.bank.toLowerCase()
    const budget = priorBudget.get(k) ?? 0
    const entry: MissingBankNumber = {
      index: row.index,
      bank: row.bank,
      canonical: inst.canonical,
      grandfathered: budget > 0,
    }
    if (entry.grandfathered) {
      priorBudget.set(k, budget - 1)
      grandfathered.push(entry)
    } else missing.push(entry)
  }
  return { ok: missing.length === 0, missing, grandfathered }
}

/** Client-facing refusal copy — names each bank and the fix. Bilingual. */
export function bankGateMessage(missing: MissingBankNumber[]): { en: string; it: string } {
  const banks = missing.map(m => m.canonical).join(", ")
  return {
    en:
      `Almost there — we need the account number (or its last 4 digits) for: ${banks}. ` +
      `It's what keeps two accounts at the same bank apart in your books. ` +
      `Enter it in each bank's "Account number" field — or tick "multi-currency service or crypto" if an account genuinely has no single number — and submit again.`,
    it:
      `Ci siamo quasi — ci serve il numero di conto (o le ultime 4 cifre) per: ${banks}. ` +
      `È ciò che distingue due conti della stessa banca nei tuoi libri contabili. ` +
      `Inseriscilo nel campo "Numero di conto" di ogni banca — oppure spunta "servizio multivaluta o crypto" se un conto non ha davvero un numero unico — e invia di nuovo.`,
  }
}
