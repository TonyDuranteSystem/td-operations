/**
 * Approval rail — pin-dependent send guard (dev job a6c3d75b).
 *
 * The council found that an approved action dispatches straight to the tool with
 * params frozen at propose time, never re-entering the worker's send executor where
 * the recipient pin lives. So the moment the action rail is switched on, an approved
 * send would run with the recipient the MODEL chose — silently skipping the pin on a
 * surface that reads mail written by strangers.
 *
 * These tests pin the guard AND catch a future send tool added without protection.
 */

import { describe, it, expect } from "vitest"
import {
  NO_APPROVAL_SEND_TOOLS,
  HARD_BLOCKED_TOOLS,
  EXTERNAL_TOOLS,
  classifyTool,
} from "@/lib/ai-agent/tool-risk"

describe("sends blocked from the approval rail", () => {
  it("covers every send path that has a server-side recipient pin", () => {
    for (const t of ["gmail_send", "portal_chat_send", "portal_team_send", "team_chat_send", "msg_send", "agent_msg_send"]) {
      expect(NO_APPROVAL_SEND_TOOLS.has(t), t).toBe(true)
    }
  })

  it("they remain EXTERNAL — the guard is defence in depth, not a reclassification", () => {
    for (const t of NO_APPROVAL_SEND_TOOLS) {
      expect(classifyTool(t, {}).tier, t).toBe("EXTERNAL")
    }
  })

  it("does NOT block ordinary data-changing actions (the rail still has a purpose)", () => {
    for (const t of ["crm_update_record", "crm_create_task", "sd_advance_stage"]) {
      expect(NO_APPROVAL_SEND_TOOLS.has(t), t).toBe(false)
    }
  })

  it("is distinct from the hard-blocked list", () => {
    for (const t of NO_APPROVAL_SEND_TOOLS) {
      expect(HARD_BLOCKED_TOOLS.has(t), t).toBe(false)
    }
  })

  /**
   * THE REGRESSION CATCHER: if someone adds a new send tool to the curated EXTERNAL
   * list and forgets the pin guard, this goes red. That is the whole point — the
   * hole existed because a safety check lived in one path and the other path grew
   * around it.
   */
  it("every curated EXTERNAL tool that SENDS is pin-guarded", () => {
    const senders = [...EXTERNAL_TOOLS].filter((n) => /(^|_)send(_|$)/.test(n))
    const unguarded = senders.filter((n) => !NO_APPROVAL_SEND_TOOLS.has(n))
    expect(
      unguarded,
      `these send tools could execute from an approval without a recipient check: ${unguarded.join(", ")}`,
    ).toEqual([])
  })
})
