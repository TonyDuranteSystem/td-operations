/**
 * Client-facing failure messages for the PUBLIC signing pages.
 *
 * WHY THIS EXISTS (council decision, 2026-07-20, dev job 023c7d06):
 * The signing pages wrote the signed PDF to Storage, inserted the contract row
 * and flipped the offer status WITHOUT CHECKING ANY OF THEM. A client could
 * sign, see "Contract Signed Successfully!", pay by wire — and TD would hold no
 * signed PDF, no contract row, and an offer still marked unsigned, while the
 * activation webhook fired anyway and created a pending activation.
 *
 * Worse than a missing check: the status update ran in a 3-attempt retry loop
 * that exits NORMALLY when all three fail, so it looked like it handled errors.
 *
 * The Web-Auditor reviewer set the content rule these messages follow, and it is
 * the whole point of the module: a failed signature is a LEGAL event, so the
 * client must be told in plain words that the document is NOT signed, and given
 * a human to contact. Never let them walk away believing it went through.
 *
 * Deliberately a pure function: this repo has NO component test infrastructure
 * (zero .tsx tests) and blocks pushes without unit tests, so the only way to get
 * these strings under test is to keep them out of the components. The I/O — the
 * fetch, the insert, the retry — stays inline in each page ON PURPOSE: a shared
 * helper that performed the write would put every signing page behind one code
 * path, which is the blast radius the council explicitly refused.
 */

export type SigningLang = "en" | "it"

/**
 * Which step of the signing sequence failed. The sequence is
 * artifact -> record -> status flip -> webhook, each gating the next, so the
 * stage tells the client how far it got.
 */
export type SigningStage =
  /** The signed PDF (or signature image) never reached storage. */
  | "document_upload"
  /** The signed document was stored, but the record of it was not written. */
  | "record"
  /** Everything was stored, but the offer/agreement could not be marked signed. */
  | "status"

const SUPPORT_EMAIL = "support@tonydurante.us"

/** Normalize anything to a supported language; unknown/absent -> English. */
export function signingLang(input: string | null | undefined): SigningLang {
  return input === "it" ? "it" : "en"
}

/**
 * True when a raw storage `fetch` did not succeed. Extracted so the check is
 * impossible to forget at a call site and is covered by a test.
 */
export function storageWriteFailed(res: { ok?: boolean; status?: number } | null | undefined): boolean {
  if (!res) return true
  if (typeof res.ok === "boolean") return !res.ok
  if (typeof res.status === "number") return res.status < 200 || res.status >= 300
  return true
}

const MESSAGES: Record<SigningLang, Record<SigningStage, string>> = {
  en: {
    document_upload:
      `Your signature was not saved — this document is NOT signed. ` +
      `Please try again. If it fails again, email ${SUPPORT_EMAIL} and we will complete it with you. ` +
      `Do not assume it went through.`,
    record:
      `We could not record your signature — this document is NOT signed. ` +
      `Please try again. If it fails again, email ${SUPPORT_EMAIL} and we will complete it with you. ` +
      `Do not assume it went through.`,
    status:
      `Your signature was saved, but we could not finish marking the document as signed. ` +
      `Please email ${SUPPORT_EMAIL} so we can confirm it — do not assume it is complete.`,
  },
  it: {
    document_upload:
      `La tua firma non è stata salvata — questo documento NON è firmato. ` +
      `Riprova. Se non funziona di nuovo, scrivi a ${SUPPORT_EMAIL} e lo completiamo insieme. ` +
      `Non dare per scontato che sia andata a buon fine.`,
    record:
      `Non siamo riusciti a registrare la tua firma — questo documento NON è firmato. ` +
      `Riprova. Se non funziona di nuovo, scrivi a ${SUPPORT_EMAIL} e lo completiamo insieme. ` +
      `Non dare per scontato che sia andata a buon fine.`,
    status:
      `La tua firma è stata salvata, ma non siamo riusciti a completare la marcatura del documento come firmato. ` +
      `Scrivi a ${SUPPORT_EMAIL} così possiamo confermarlo — non dare per scontato che sia completo.`,
  },
}

/**
 * The message shown to the client when a signing step fails.
 *
 * `detail` (an HTTP status, a database message) is DELIBERATELY NOT included in
 * the returned string — it goes to the console for us. A raw Supabase or storage
 * error shown on a legal-signing screen reads as a broken site, and can leak
 * internal shape. Callers log the detail; the client reads plain words.
 */
export function signingFailureMessage(stage: SigningStage, lang: SigningLang): string {
  return MESSAGES[lang][stage]
}

/**
 * An error whose message is already complete, client-ready copy.
 *
 * The signing pages' catch blocks decorate unknown errors (e.g.
 * `'Error: ' + e.message + '. Please try again.'`) — which is right for a raw
 * exception, but would mangle these messages into a doubled "Please try again"
 * and a stray period on a legal-signing screen. Catch blocks check
 * `isClientFacingError` and render `.message` verbatim instead.
 */
export class SigningFailure extends Error {
  readonly clientFacing = true as const

  constructor(stage: SigningStage, lang: SigningLang) {
    super(signingFailureMessage(stage, lang))
    this.name = "SigningFailure"
  }
}

/**
 * True when the error already carries finished client copy that must be shown
 * as-is. Duck-typed rather than `instanceof` so it survives bundling and any
 * future error that opts in with the same flag.
 */
export function isClientFacingError(e: unknown): e is Error {
  return Boolean(e) && typeof e === "object" && (e as { clientFacing?: unknown }).clientFacing === true
}
