/**
 * TD Marketing (dev job 9aec66fa): when a "Forgot your password?" request cannot be served, Antonio is told in the team chat with the exact fix - once per person per six hours - and the alert itself can never break the request.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const state = { recent: [] as Array<{ id: string }>, ilike: "" as string, route: "" as string }
const chain: Record<string, unknown> = {}
const api = {
  select: () => chain, eq: (_c: string, v: string) => { state.route = v; return chain },
  ilike: (_c: string, v: string) => { state.ilike = v; return chain }, gte: () => chain,
  limit: async () => ({ data: state.recent, error: null }),
}
Object.assign(chain, api)
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { from: () => chain } }))
const reportSystemError = vi.fn(async (_i: unknown) => ({ fingerprint: "f" }))
vi.mock("@/lib/system-errors", () => ({ reportSystemError: (i: unknown) => reportSystemError(i) }))
const postTeamMessage = vi.fn(async (_i: { channel: string; message: string }) => ({}))
vi.mock("@/lib/team/post-message", () => ({ postTeamMessage: (i: { channel: string; message: string }) => postTeamMessage(i) }))

import { alertForgotProblem, forgotProblemMessage, FORGOT_ALERT_ROUTE } from "@/lib/marketing/reset-alert"

beforeEach(() => { state.recent = []; state.ilike = ""; reportSystemError.mockClear(); postTeamMessage.mockReset(); postTeamMessage.mockResolvedValue({}) })

describe("forgotProblemMessage", () => {
  it("says who, what went wrong and the exact way to fix it", () => {
    const m = forgotProblemMessage("rocco@tonydurante.us", "the email could not be sent: gmail down")
    expect(m).toContain("rocco@tonydurante.us")
    expect(m).toContain("the email could not be sent: gmail down")
    expect(m).toMatch(/Team page/)
    expect(m).toMatch(/Reset password/)
    expect(m).toMatch(/send it to them yourself/)
  })
})

describe("alertForgotProblem", () => {
  it("posts to the bug channel and records the error, once", async () => {
    await alertForgotProblem("rocco@tonydurante.us", "the email could not be sent: gmail down")
    expect(postTeamMessage).toHaveBeenCalledTimes(1)
    expect(postTeamMessage.mock.calls[0][0].channel).toBe("td-bug")
    expect(postTeamMessage.mock.calls[0][0].message).toContain("rocco@tonydurante.us")
    expect(reportSystemError).toHaveBeenCalledTimes(1)
    expect((reportSystemError.mock.calls[0][0] as { route: string }).route).toBe(FORGOT_ALERT_ROUTE)
  })
  it("stays quiet when the same person was already reported in the last six hours", async () => {
    state.recent = [{ id: "e1" }]
    await alertForgotProblem("rocco@tonydurante.us", "x")
    expect(postTeamMessage).not.toHaveBeenCalled()
    expect(reportSystemError).not.toHaveBeenCalled()
  })
  it("an underscore or percent sign in an address only matches itself", async () => {
    await alertForgotProblem("a_b%c@example.test", "x")
    expect(state.ilike).toBe("%a\\_b\\%c@example.test pressed%")
  })
  it("never throws, even when the chat is down", async () => {
    postTeamMessage.mockRejectedValue(new Error("chat down"))
    await expect(alertForgotProblem("rocco@tonydurante.us", "x")).resolves.toBeUndefined()
  })
})
