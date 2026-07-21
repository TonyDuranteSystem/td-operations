/**
 * Client-facing messages for a failed FILE UPLOAD on the public data-collection
 * forms (tax, banking, closure, onboarding, formation).
 *
 * WHY THIS EXISTS (council decision, 2026-07-20, dev job 023c7d06):
 * Every one of those forms did this:
 *
 *     if (!upErr) uploadPaths.push(path)
 *
 * A failed upload was simply not added to the array — no else, no error, no
 * message — and the form then wrote `status: 'completed'` and rendered the green
 * success screen. A client uploaded a passport, the upload failed, and they were
 * told the submission was received. Staff saw a complete submission with a
 * missing document. Nobody found out until the document was needed.
 *
 * THE DECISION (Project Director, tiebreaking Senior Engineer vs Web Auditor):
 * BLOCK the submission, but ONLY when a file the client actually attached failed
 * to upload. Not when they chose to attach nothing — that is an ordinary business
 * gap the review loop already handles.
 *
 * Both sides of that argument rested on something false, which is why the
 * decision is narrower than either:
 *   - "Blocking loses the client's whole form" — it does not. The submit handlers
 *     catch, set an error and clear the submitting flag; `submitted` stays false
 *     and every typed answer is untouched React state. It costs one retry click.
 *   - "There is no required-vs-optional flag" — banking has one. But the flags
 *     differ per form, which is exactly why blocking on REQUIREDNESS would be
 *     over-engineering while blocking on FAILED INTENT is proportionate.
 *
 * Deliberately ruled OUT of this change, so nobody re-adds it: a
 * `missing_documents` column and its migration. Under a hard block the gap can
 * no longer be created by a system failure, so recording it would be recording
 * an event that can no longer happen — and it would drag a hand-applied
 * production migration into the path of the remaining security work.
 *
 * Pure by necessity: this repo has NO component test infrastructure (zero .tsx
 * tests) and blocks pushes without unit tests, so the only way these strings and
 * this decision get covered is to keep them out of the components.
 */

export type UploadLang = "en" | "it"

/** One file the client attached that did not reach storage. */
export interface FailedUpload {
  /** The field the file was attached to (e.g. "passport_owner"). */
  key: string
  /** The client's own filename — they recognise this, not the storage key. */
  fileName: string
}

const SUPPORT_EMAIL = "support@tonydurante.us"

/** Normalize anything to a supported language; unknown/absent -> English. */
export function uploadLang(input: string | null | undefined): UploadLang {
  return input === "it" ? "it" : "en"
}

/**
 * The submission must be blocked when at least one ATTACHED file failed.
 *
 * Takes the failures rather than comparing counts on purpose: the formation
 * form's original guard was `uploadErrors.length > 0 && uploadPaths.length === 0`,
 * which let a batch through as `completed` whenever ANY file succeeded — so a
 * 2-of-3 passport upload silently filed with a passport missing, after the code
 * had explicitly validated that passport as mandatory. There is no count here to
 * get wrong.
 */
export function shouldBlockSubmission(failures: readonly FailedUpload[]): boolean {
  return failures.length > 0
}

/**
 * What the client reads when an attached file did not upload.
 *
 * Names the actual files (they recognise their own filenames), says their
 * answers are safe so they do not fear losing the form, and gives a human to
 * contact — a failure with no way forward strands the client. The underlying
 * storage/database error is NOT included; that goes to the console.
 */
export function uploadFailureMessage(failures: readonly FailedUpload[], lang: UploadLang): string {
  if (failures.length === 0) return ""
  const names = failures.map(f => f.fileName).join(", ")

  if (lang === "it") {
    const head = failures.length === 1
      ? `Non siamo riusciti a caricare questo file: ${names}.`
      : `Non siamo riusciti a caricare questi file: ${names}.`
    return `${head} Le tue risposte sono al sicuro — non è stato inviato nulla. ` +
      `Riprova, oppure rimuovi il file e invia il resto. ` +
      `Se continua a non funzionare, scrivi a ${SUPPORT_EMAIL}.`
  }

  const head = failures.length === 1
    ? `We could not upload this file: ${names}.`
    : `We could not upload these files: ${names}.`
  return `${head} Your answers are safe — nothing has been submitted yet. ` +
    `Please try again, or remove the file and submit the rest. ` +
    `If it keeps failing, email ${SUPPORT_EMAIL}.`
}
