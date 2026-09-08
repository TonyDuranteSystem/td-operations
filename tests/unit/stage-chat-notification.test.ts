/**
 * Pure-logic tests for the optional stage-advance portal-chat message
 * decision (sibling to the notify_client_email milestone email).
 */

import { describe, expect, it } from "vitest"
import { resolveStageChatNotification } from "@/lib/portal/stage-chat-notification"

const BASE = {
  hasActionStageConfig: false,
  hasRecipient: true,
  notify_client_chat: true,
  client_chat_topic: "ITIN",
  client_notification_message: null,
  client_description: null,
  service_type: "ITIN",
  service_name: "ITIN",
  stage_name: "Submitted to IRS",
}

describe("resolveStageChatNotification", () => {
  it("returns null when skip_notify is set (bulk reconcile/backfill)", () => {
    expect(resolveStageChatNotification({ ...BASE, skip_notify: true })).toBeNull()
  })

  it("returns null when the stage is an action-required stage (8-pre owns those)", () => {
    expect(resolveStageChatNotification({ ...BASE, hasActionStageConfig: true })).toBeNull()
  })

  it("returns null when notify_client_chat is not set on the stage", () => {
    expect(resolveStageChatNotification({ ...BASE, notify_client_chat: false })).toBeNull()
    expect(resolveStageChatNotification({ ...BASE, notify_client_chat: null })).toBeNull()
    expect(resolveStageChatNotification({ ...BASE, notify_client_chat: undefined })).toBeNull()
  })

  it("returns null when the delivery has neither an account nor a contact", () => {
    expect(resolveStageChatNotification({ ...BASE, hasRecipient: false })).toBeNull()
  })

  it("uses the stage's fixed topic and the per-stage notification message when both are set", () => {
    const decision = resolveStageChatNotification({
      ...BASE,
      client_notification_message: "Your ITIN application has been mailed to the IRS.",
    })
    expect(decision).toEqual({
      topic: "ITIN",
      message: "Your ITIN application has been mailed to the IRS.",
    })
  })

  it("falls back to client_description when there is no dedicated notification message", () => {
    const decision = resolveStageChatNotification({
      ...BASE,
      client_notification_message: null,
      client_description: "Your ITIN application has been mailed to the IRS.",
    })
    expect(decision?.message).toBe("Your ITIN application has been mailed to the IRS.")
  })

  it("falls back to a generic templated message when no stage copy exists at all", () => {
    const decision = resolveStageChatNotification({
      ...BASE,
      client_notification_message: null,
      client_description: null,
    })
    expect(decision?.message).toBe("ITIN update: Submitted to IRS.")
  })

  it("falls back to the service type when the stage has no fixed chat topic", () => {
    const decision = resolveStageChatNotification({ ...BASE, client_chat_topic: null })
    expect(decision?.topic).toBe("ITIN")
  })

  it("never computes a topic from a year — the fixed topic is used verbatim", () => {
    const decision = resolveStageChatNotification({ ...BASE, client_chat_topic: "ITIN" })
    expect(decision?.topic).toBe("ITIN")
    expect(decision?.topic).not.toMatch(/\d{4}/)
  })
})
