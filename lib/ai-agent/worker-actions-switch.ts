/**
 * Worker action rail — single reversible OFF switch (2026-07-10, Antonio).
 *
 * Antonio's decision: NO worker or helper — on ANY surface (Slack worker,
 * team-chat @claude, CRM inbox helper, portal-reply drafter, the dormant Hermes
 * bridge) — may queue an approval action (propose_action) or launch/ship a coding
 * job (start_code_task / promote_code_branch). The worker sends on his "go" and
 * investigates on his "investigate it"; everything else he does himself in code.
 *
 * This is the ONE choke point. Both the queue path (proposeAction) and the
 * code-task executor branches call workerActionsEnabled() and refuse when off. It
 * is an ENABLE flag that DEFAULTS OFF: unless WORKER_ACTIONS_ENABLED === 'true'
 * is explicitly set on the deployment, the rail is dead. That makes OFF a genuine
 * env flip (reversible in seconds) rather than deleted code — Antonio chose the
 * reversible shape over a permanent teardown.
 *
 * Pure + DB-free so it's trivially unit-testable and safe to import anywhere.
 */

/** True only when the worker action rail is explicitly switched on. Default OFF. */
export function workerActionsEnabled(): boolean {
  return process.env.WORKER_ACTIONS_ENABLED === "true"
}

/** Standard refusal returned to the model when the rail is off. */
export const WORKER_ACTIONS_OFF_MESSAGE =
  "🔒 I can't queue actions or launch code — that's switched off. I can look into it and report back, or draft a message for you to send on your \"go\"; anything that changes data or ships code, you do yourself."
