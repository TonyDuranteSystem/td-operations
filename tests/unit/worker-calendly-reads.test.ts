/**
 * Unit tests for the Slack-only Calendly read rail in worker-tools.ts.
 *
 * Network-free: with no CALENDLY_PAT, the shared fetch helper throws before any
 * HTTP call, so the executor's error formatting is deterministic.
 */

import { describe, it, expect, beforeEach } from "vitest"
import {
  WORKER_TOOLS,
  CAL_LIST_BOOKINGS_TOOL,
  CAL_GET_EVENT_TOOL,
  CAL_GET_AVAILABILITY_TOOL,
  executeWorkerTool,
} from "@/lib/ai-agent/worker-tools"

const calNames = [CAL_LIST_BOOKINGS_TOOL, CAL_GET_EVENT_TOOL, CAL_GET_AVAILABILITY_TOOL].map((t) => t.name)

beforeEach(() => {
  delete process.env.CALENDLY_PAT // force the no-token path (no network)
})

describe("Calendly worker rail (Slack-only, R108)", () => {
  it("the 3 Calendly tools are NOT in WORKER_TOOLS (Hermes/Telegram never get them)", () => {
    const names = new Set(WORKER_TOOLS.map((t) => t.name))
    for (const n of calNames) expect(names.has(n)).toBe(false)
  })

  it("tool defs are the expected read-only set", () => {
    expect(calNames).toEqual(["cal_list_bookings", "cal_get_event_details", "cal_get_availability"])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((CAL_GET_EVENT_TOOL.parameters as any).required).toContain("event_uuid")
  })

  it("executor REFUSES a Calendly tool when not gated in (availableNames missing it)", async () => {
    const res = await executeWorkerTool("cal_list_bookings", {}, new Set())
    expect(res).toContain("not permitted")
    expect(res).toContain("Calendly not enabled")
  })

  it("executor dispatches to the shared fn when gated in (clean error without a token)", async () => {
    const res = await executeWorkerTool("cal_list_bookings", {}, new Set(["cal_list_bookings"]))
    expect(res).toContain("List bookings failed")
    expect(res).toContain("CALENDLY_PAT")
  })

  it("cal_get_event_details requires event_uuid before any fetch", async () => {
    const res = await executeWorkerTool("cal_get_event_details", {}, new Set(["cal_get_event_details"]))
    expect(res).toContain("event_uuid is required")
  })

  it("cal_get_availability dispatches when gated in (clean error without a token)", async () => {
    const res = await executeWorkerTool("cal_get_availability", {}, new Set(["cal_get_availability"]))
    expect(res).toContain("Get availability failed")
    expect(res).toContain("CALENDLY_PAT")
  })
})
