/**
 * Onboarding setup — did the client's PAPERS get filed? (Stop Drive S1d, dev job 264bb882)
 *
 * The setup job runs many independent steps and used to end "completed" whatever happened to them, so a company whose uploads and
 * data summary were never filed looked like a success. If any FILING step failed the job now ends FAILED — terminally, because
 * running the whole setup again is a person's decision (it would repeat tasks, leases and messages), not an automatic retry.
 * A member passport deliberately held because the member has no contact yet is NOT a failure (it has its own staff alarm and is
 * filed when the member has a contact).
 */

export interface StepLike { name: string; status: string; detail?: string }

const FILING = /^(drive_folder|doc_copy|doc_copy_summary|store_uploads|data_summary_pdf|member_\d+_passport)$/
const HELD_ON_PURPOSE = /^Kept on the submission/

/** The failed filing steps, as short plain sentences. */
export function filingFailures(steps: StepLike[]): string[] {
  return steps
    .filter((s) => s.status === "error" && FILING.test(s.name) && !HELD_ON_PURPOSE.test(s.detail ?? ""))
    .map((s) => `${s.name}: ${s.detail ?? "failed"}`)
}

/** Apply the rule to a finished result: failed filing => ok:false + terminal + a summary that says so. */
export function applyFilingOutcome<R extends { steps: StepLike[]; ok?: boolean; terminal?: boolean; summary?: string }>(result: R): R {
  const failed = filingFailures(result.steps)
  if (failed.length === 0) return result
  result.ok = false
  result.terminal = true
  result.summary = `FAILED — the client's papers were not (all) filed: ${failed.join(" | ")}. ${result.summary ?? ""}`.trim()
  return result
}
