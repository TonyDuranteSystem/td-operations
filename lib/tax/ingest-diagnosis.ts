/**
 * Statement-ingest failure DIAGNOSIS — one classification, one copy source.
 *
 * Antonio's rule (Wave 2, card 4a39e0fd, 2026-08-13): "tell the client what's
 * wrong, never ask him why — he doesn't know." The production fact behind it:
 * 39 of 217 ingests failed since 26 June (18%), and none of the three real
 * client failures was a damaged file — PAMAG uploaded 2026 statements for a
 * 2025 return, Nova Ratio uploaded QuickBooks exports instead of bank
 * statements, Economicamente's June was an empty month. All three fixable by
 * the client in minutes — if the message says WHAT is wrong and the fix.
 *
 * ONE SOURCE OF COPY: the portal chat message (wizard-failure-notify) and the
 * file card on the financials page both render from this module — they can
 * never contradict again (the shipped copy said "no action is needed" in chat
 * and "delete and re-upload" on the page for the SAME file).
 *
 * CLIENT-SAFE: pure data + functions, no server imports — the review component
 * renders from it directly.
 */

export type IngestDiagnosisCode =
  /** The file parsed fine but its transactions belong to another year. */
  | "wrong_year"
  /** The file is an accounting-software export, not a bank statement. */
  | "not_bank_statement"
  /** A real statement whose period simply has no transactions. */
  | "empty_period"
  /** We could not read the file and cannot say why. */
  | "unreadable"

export interface IngestDiagnosis {
  code: IngestDiagnosisCode
  /** Years actually found in a wrong_year file (e.g. [2026]). */
  found_years?: number[]
  /** The year the return needs. */
  expected_year?: number
  /** The accounting software recognised, when we could tell ("QuickBooks"). */
  software?: string
}

/**
 * Sniff whether a CSV that yielded zero transactions is an ACCOUNTING export.
 * Signature columns are distinctive of ledger software and never appear in a
 * bank's own transaction export. Conservative: two independent signals
 * required, so a bank CSV with one odd column name can't be misbranded.
 */
export function sniffAccountingExport(headerLine: string): { isAccountingExport: boolean; software?: string } {
  const h = headerLine.toLowerCase()
  const has = (s: string) => h.includes(s)
  // QuickBooks transaction/journal exports
  const qbSignals = [has("transaction type"), has("split"), has("memo/description"), has("posting"), has("qbo")]
  if (qbSignals.filter(Boolean).length >= 2) return { isAccountingExport: true, software: "QuickBooks" }
  // Xero journal/account exports
  const xeroSignals = [has("journal number"), has("account code"), has("gross"), has("tax amount")]
  if (xeroSignals.filter(Boolean).length >= 2) return { isAccountingExport: true, software: "Xero" }
  // Generic double-entry ledger export: debit+credit columns plus a journal/account-code notion
  if (has("debit") && has("credit") && (has("journal") || has("account code") || has("ledger"))) {
    return { isAccountingExport: true }
  }
  return { isAccountingExport: false }
}

export interface DiagnosisCopy {
  /** What is wrong + the fix, one paragraph, client language. Used VERBATIM by
   *  the chat message and the file card — one truth, two surfaces. */
  en: string
  it: string
}

/** The generic unreadable copy, shared so the fallback never forks either. */
const UNREADABLE: DiagnosisCopy = {
  en:
    "We could not read this file. Please remove it below and upload the statement exactly as your bank exports it — " +
    "the CSV or the official PDF for the full period, one file per bank account. " +
    "Do not merge, combine, or edit files: tools like merge-csv.com change the format and make the file unreadable.",
  it:
    "Non siamo riusciti a leggere questo file. Rimuovilo qui sotto e carica l'estratto conto esattamente come lo esporta la tua banca — " +
    "il CSV o il PDF ufficiale per l'intero periodo, un file per conto. " +
    "Non unire, combinare o modificare i file: strumenti come merge-csv.com cambiano il formato e rendono il file illeggibile.",
}

/**
 * The client-facing explanation for a diagnosis: what's wrong and the fix.
 * Never asks the client why. Bilingual by contract — every code has both.
 */
export function diagnosisCopy(diag: IngestDiagnosis | null | undefined): DiagnosisCopy {
  if (!diag) return UNREADABLE
  switch (diag.code) {
    case "wrong_year": {
      const found = (diag.found_years ?? []).join(", ")
      const want = diag.expected_year ?? "the tax year"
      return {
        en:
          `This file contains ${found || "another year's"} transactions — we need ${want}. ` +
          `Please export January 1 to December 31, ${want} from your bank and upload that file (remove this one below).`,
        it:
          `Questo file contiene transazioni ${found ? `del ${found}` : "di un altro anno"} — ci serve il ${want}. ` +
          `Esporta dalla tua banca il periodo 1 gennaio – 31 dicembre ${want} e carica quel file (rimuovi questo qui sotto).`,
      }
    }
    case "not_bank_statement": {
      const sw = diag.software ? ` (${diag.software})` : ""
      return {
        en:
          `This looks like an accounting export${sw}, not a bank statement. ` +
          `Please download the transactions CSV from your bank itself and upload that instead (remove this file below).`,
        it:
          `Questo sembra un export contabile${sw}, non un estratto conto. ` +
          `Scarica il CSV dei movimenti direttamente dalla tua banca e carica quello (rimuovi questo file qui sotto).`,
      }
    }
    case "empty_period":
      return {
        en:
          "This statement was read correctly — it has no transactions for its period. " +
          "If the account was simply inactive that month, confirm it in the Year coverage section; nothing else is needed.",
        it:
          "Questo estratto conto è stato letto correttamente — non ha transazioni nel suo periodo. " +
          "Se il conto era semplicemente inattivo quel mese, confermalo nella sezione Copertura dell'anno; non serve altro.",
      }
    case "unreadable":
      return UNREADABLE
  }
}
