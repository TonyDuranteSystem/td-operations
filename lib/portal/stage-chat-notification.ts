/**
 * Pure decision logic for the optional stage-advance portal-chat message
 * (sibling to the notify_client_email milestone email in service-delivery.ts,
 * section "8b-chat", 2026-09-08). Kept in its own small module — like
 * lib/flows/resolve-flows.ts and lib/tasks/itin-processing-reminder.ts — so
 * the decision can be unit-tested without mocking the whole advance function.
 */

export interface StageChatNotificationInput {
  skip_notify?: boolean | null
  hasActionStageConfig: boolean
  hasRecipient: boolean
  notify_client_chat?: boolean | null
  client_chat_topic?: string | null
  client_notification_message?: string | null
  client_description?: string | null
  service_type?: string | null
  service_name?: string | null
  stage_name: string
}

export interface StageChatNotificationDecision {
  topic: string
  message: string
}

/**
 * Returns the {topic, message} to post, or null if this stage advance
 * should NOT get an automatic chat message. Mirrors the same guards as the
 * sibling notify_client_email block (skip_notify, actionStageCfg, a
 * recipient) so a bulk correction or an action-required stage can't double
 * up here either.
 *
 * Topic is always the stage's own FIXED client_chat_topic (falling back to
 * the service type) — never a computed/year-suffixed one. buildFlowTopic()'s
 * year, resolved off a moving timestamp, was found (2026-09-08) to split one
 * client's own conversation across topics as a single case ages past a
 * calendar year boundary — see docs/systems/flows.md.
 */
export function resolveStageChatNotification(
  input: StageChatNotificationInput,
): StageChatNotificationDecision | null {
  if (input.skip_notify) return null
  if (input.hasActionStageConfig) return null
  if (!input.notify_client_chat) return null
  if (!input.hasRecipient) return null

  const topic = input.client_chat_topic || input.service_type || "General"
  const message =
    input.client_notification_message ||
    input.client_description ||
    `${input.service_name || input.service_type || "Service"} update: ${input.stage_name}.`

  return { topic, message }
}
