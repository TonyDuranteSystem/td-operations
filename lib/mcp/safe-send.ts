/**
 * safeSend — Enforces correct ordering for all "send" operations.
 *
 * RULE: Status updates MUST happen AFTER the actual send operation.
 * This helper enforces that pattern + adds idempotency and multi-step tracking.
 *
 * Usage:
 *   const result = await safeSend({
 *     idempotencyCheck: async () => { ... return { alreadySent: true, message: "..." } or null },
 *     sendFn: async () => { ... return sendResult },
 *     postSendSteps: [
 *       { name: "update_status", fn: async () => { ... } },
 *       { name: "update_lead", fn: async () => { ... } },
 *       { name: "save_tracking", fn: async () => { ... } },
 *     ],
 *   })
 *
 * How it works:
 *   1. Runs idempotencyCheck (if provided) — returns early if already sent
 *   2. Executes sendFn — the actual email/notification send
 *   3. Only if sendFn succeeds, runs all postSendSteps in order
 *   4. Each step is tracked (ok/error) — partial failures don't lose the send
 *   5. Returns structured result with step-by-step status
 *
 * MANDATORY: Every MCP tool that sends something (email, notification, etc.)
 * and then updates a DB status MUST use this helper. See CLAUDE.md.
 */

export interface SendStep {
  name: string
  fn: () => Promise<void>
}

export interface SafeSendOptions<T = unknown> {
  /** Optional idempotency check. Return { alreadySent: true, message } to skip. */
  idempotencyCheck?: () => Promise<{ alreadySent: true; message: string } | null>
  /** The actual send operation. Runs FIRST. Must throw on failure. */
  sendFn: () => Promise<T>
  /** Steps to run AFTER successful send (status updates, tracking, logging). */
  postSendSteps: SendStep[]
}

export interface SafeSendResult<T = unknown> {
  alreadySent: boolean
  /** Message if idempotency check caught a duplicate */
  idempotencyMessage?: string
  /** Result from sendFn (e.g. gmail message ID, thread ID) */
  sendResult?: T
  /** Step-by-step tracking of post-send operations */
  steps: { step: string; status: "ok" | "error"; error?: string }[]
  /** True if any post-send step failed (send itself succeeded) */
  hasWarnings: boolean
}

export async function safeSend<T = unknown>(
  options: SafeSendOptions<T>
): Promise<SafeSendResult<T>> {
  // 1. Idempotency check
  if (options.idempotencyCheck) {
    const check = await options.idempotencyCheck()
    if (check?.alreadySent) {
      return {
        alreadySent: true,
        idempotencyMessage: check.message,
        steps: [],
        hasWarnings: false,
      }
    }
  }

  // 2. Execute the actual send — this MUST succeed before any status update
  const sendResult = await options.sendFn()

  // 3. Run post-send steps (status updates, tracking, logging)
  // These are best-effort: if one fails, we continue with the rest
  const steps: { step: string; status: "ok" | "error"; error?: string }[] = [
    { step: "send", status: "ok" },
  ]

  for (const step of options.postSendSteps) {
    try {
      await step.fn()
      steps.push({ step: step.name, status: "ok" })
    } catch (err) {
      steps.push({
        step: step.name,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    alreadySent: false,
    sendResult,
    steps,
    hasWarnings: steps.some((s) => s.status === "error"),
  }
}
