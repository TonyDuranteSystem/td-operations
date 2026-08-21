/**
 * Automatic lease + Operating Agreement creation — single reversible OFF
 * switch (2026-08-19, Antonio).
 *
 * Antonio's decision: the client-onboarding job and the new-company
 * welcome-package job (fired automatically on EIN receipt) no longer
 * auto-create a client's lease or Operating Agreement. Staff create both
 * manually from the account page's existing "Generate Lease" / "Generate OA"
 * buttons instead. Both jobs call autoDocumentCreationEnabled() before each
 * creation step and skip with a logged reason when off — never silently.
 *
 * DEFAULT OFF: unset (or anything other than the literal string "true") means
 * off. Flipping AUTO_LEASE_OA_CREATION_ENABLED=true on the deployment turns
 * automatic creation back on for both jobs at once, no code change needed —
 * the reversible-switch shape matches workerActionsEnabled()
 * (lib/ai-agent/worker-actions-switch.ts).
 *
 * Deliberately no fallback task/reminder when a step is skipped — Antonio's
 * explicit call: staff handle it manually, nothing pushed to anyone.
 *
 * Pure + DB-free so it's trivially unit-testable and safe to import anywhere.
 */

/** True only when automatic lease/OA creation is explicitly switched on. Default OFF. */
export function autoDocumentCreationEnabled(): boolean {
  return process.env.AUTO_LEASE_OA_CREATION_ENABLED === "true"
}
