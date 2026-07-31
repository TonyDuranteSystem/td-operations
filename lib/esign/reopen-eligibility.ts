/**
 * Reopen eligibility — the pure rule for "may this expired envelope go back in
 * flight, and in what status?".
 *
 * Isolated from the route so the refusals are unit-testable: every one of them
 * came out of an adversarial review, and each protects against a failure that
 * is silent in production rather than obvious.
 */

export type ReopenRefusal =
  | "not_expired"
  | "fully_signed"
  | "has_declined_signer"
  | "no_actionable_signer"

/**
 * Discriminated on a STRING, not a boolean: this project compiles with
 * `strict: false`, and without strictNullChecks TypeScript does not narrow a
 * union on a `true`/`false` discriminant — `if (!d.ok)` compiles but leaves
 * `d` un-narrowed, so a typo in the refusal branch would not be caught.
 */
export type ReopenDecision =
  | { kind: "allowed"; nextStatus: "sent" | "in_progress" }
  | { kind: "refused"; reason: ReopenRefusal; message: string }

export interface ReopenInput {
  status: string
  signed_count: number
  total_signers: number
  signers: Array<{ status: string }>
}

/**
 * Decide whether an envelope may be reopened.
 *
 * Refusals, and why each exists:
 *
 * - not_expired — reopen is ONLY for expiry. Voided and declined are decisions
 *   somebody made and must not be undone by a button; completed is finished.
 *   (Reopening those would also be a legal misrepresentation of the record.)
 *
 * - fully_signed — a fully-signed envelope CAN be sitting in 'expired': the
 *   expiry cron runs every 6h and can land between the submit route's terminal
 *   check and its guarded completion claim, leaving every signature recorded
 *   and counted but the envelope never flipped to completed. Reopening that one
 *   puts it back into 'in_progress', where the cron's reconcile step flattens
 *   it, completes it and FILES the signed PDF into the client's Drive and
 *   portal — a second signed copy of a tax return, appearing without anyone
 *   asking for it. That case needs an explicit "finish and file it" action, not
 *   a reopen.
 *
 * - has_declined_signer — a signer can be 'declined' while the envelope is not
 *   (the decline route only flips the envelope from sent/in_progress, so a
 *   decline against a still-draft envelope leaves the envelope alone). Such an
 *   envelope can never reach signed_count === total_signers, so reopening it
 *   produces a document that hangs in_progress forever, shows in the client's
 *   to-sign list, and quietly expires again.
 *
 * - no_actionable_signer — nobody left to chase; reopening changes nothing.
 */
export function decideReopen(env: ReopenInput): ReopenDecision {
  if (env.status !== "expired") {
    return {
      kind: "refused",
      reason: "not_expired",
      message: `Only an expired document can be reopened — this one is ${String(env.status).replace("_", " ")}.`,
    }
  }

  if (env.signers.some(s => s.status === "declined")) {
    return {
      kind: "refused",
      reason: "has_declined_signer",
      message:
        "Someone declined to sign this document, so it can never be completed. Create a new document instead.",
    }
  }

  const total = env.total_signers ?? env.signers.length
  if (total > 0 && (env.signed_count ?? 0) >= total) {
    return {
      kind: "refused",
      reason: "fully_signed",
      message:
        "Everyone has already signed this document — it expired before it finished processing. It needs to be completed and filed, not reopened. Flag it so it can be finished properly.",
    }
  }

  if (!env.signers.some(s => s.status === "pending" || s.status === "sent" || s.status === "viewed")) {
    return {
      kind: "refused",
      reason: "no_actionable_signer",
      message: "Nobody is left to sign this document, so reopening it would not change anything.",
    }
  }

  // A partially-signed envelope resumes as in_progress; an untouched one as
  // sent. Both are legal statuses and both are visible to the portal to-sign
  // list and the CRM, which key off exactly this pair.
  return { kind: "allowed", nextStatus: (env.signed_count ?? 0) > 0 ? "in_progress" : "sent" }
}
