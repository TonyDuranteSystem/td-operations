/**
 * Company Closure — the one rule for "this move closes the company" (production end-to-end test 2026-11-07, dev job eaa4747e).
 *
 * Reaching the job's last step, "Closing", closes the whole company (section 14 of `advanceServiceDelivery`). Only the workspace finish
 * button used to ask first; the step bar, the MCP tool `sd_advance_stage` and the to-do card moved the job there with no question (the
 * step bar showed a bare "Move to Closing?"). Now the SERVER refuses such a move unless the caller says the question was answered
 * (`company_close_confirmed`) or the job is finished WITHOUT closing the company (`skip_company_close`), so no door is left open.
 *
 * Pure — no database.
 */

/** The last step of Company Closure: reaching it closes the company the job is linked to. */
export const CLOSING_STEP_NAME = "Closing"

/** True when moving the job to `targetStage` would close a company: a Company Closure job linked to a company, moving to the last step. */
export function movingClosesCompany(p: { serviceType: string | null | undefined; targetStage: string | null | undefined; hasCompany: boolean }): boolean {
  return p.hasCompany && p.serviceType === "Company Closure" && p.targetStage === CLOSING_STEP_NAME
}

/** Where the in-page question stands while it reads which company it closes: loading, shown, nothing to show (no company), or the read FAILED. */
export type ClosingQuestionState = "loading" | "ready" | "none" | "failed"

/**
 * Which buttons the question offers. "Yes" is possible ONLY once staff can see what it does (or when there is nothing to show): when the read
 * failed it used to fall back to the generic sentence with "Yes" still enabled — closing a company blind (production test 2026-11-07).
 * "Finish without closing the company" only when the wizard raised a warning (it wrote another company than the job's).
 */
export function closingQuestionButtons(state: ClosingQuestionState, hasWarning: boolean): { canConfirm: boolean; showSkip: boolean; showRetry: boolean } {
  return { canConfirm: state === "ready" || state === "none", showSkip: state === "ready" && hasWarning, showRetry: state === "failed" }
}

/** The sentence the in-page question starts with when the step bar (not the finish button) asks. */
export const STEP_BAR_CLOSE_QUESTION =
  "Moving this job to Closing CLOSES THE COMPANY in the CRM: the account is set to Closed, the portal is turned off and the company’s other open services are cancelled. Continue?"

/**
 * What the server answers when a move that closes the company arrives without the question having been answered. Written for STAFF (the
 * to-do card shows it as its "Action failed" line — a sentence about "a tool" confused it, live test 2026-11-08); the MCP tool adds
 * `COMPANY_CLOSE_TOOL_HINT` for the agent.
 */
export const COMPANY_CLOSE_NOT_CONFIRMED =
  "Moving this job to Closing closes the company, so it needs the confirmation question first. Open the job in its workspace and use the finish button (or the step bar there): it shows which company is closed and what goes with it."

/** Added by the MCP tool `sd_advance_stage` after `COMPANY_CLOSE_NOT_CONFIRMED`: what an agent has to do. */
export const COMPANY_CLOSE_TOOL_HINT = " From a tool, pass confirm_company_close only after the person in charge has seen that."

/**
 * The warning staff must see when finishing the job did NOT fully close the company: the "Closure problem:" lines of the advance result
 * (production end-to-end test 2026-11-07). Shared by the advance route (finish button) and the step bar's move, so both doors say it.
 * Null when every step worked.
 */
export function closureProblemWarning(autoTriggers: readonly string[] | null | undefined): string | null {
  const prefix = "Closure problem: "
  const problems = (autoTriggers ?? []).filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length))
  return problems.length > 0 ? `The job finished, but closing the company did not fully work: ${problems.join(" · ")}. Check the company before relying on it.` : null
}

/** The Documents box of a Company Closure job when it is empty: the client's files are listed a few minutes after the form is sent (the filing is finished by a background retry). */
export const CLOSURE_DOCUMENTS_EMPTY_TEXT =
  "No documents listed yet. If the client has just sent the form, their files are still being filed and appear here within a few minutes — this box checks again by itself."
