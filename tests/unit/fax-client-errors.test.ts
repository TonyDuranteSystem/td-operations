import { describe, it, expect } from "vitest"
import { faxSendFailureText, FAX_OUTCOME_UNKNOWN_SENTENCE } from "@/lib/fax/client-errors"

describe("faxSendFailureText", () => {
  it("a dropped connection, or a 502 / 504 / killed function with no JSON body = outcome unknown, do NOT resend", () => {
    expect(faxSendFailureText({ networkError: true })).toBe(FAX_OUTCOME_UNKNOWN_SENTENCE)
    for (const status of [500, 502, 503, 504]) expect(faxSendFailureText({ status, json: null }), String(status)).toBe(FAX_OUTCOME_UNKNOWN_SENTENCE)
    expect(FAX_OUTCOME_UNKNOWN_SENTENCE).toMatch(/NOT known/); expect(FAX_OUTCOME_UNKNOWN_SENTENCE).toMatch(/Do NOT send it again/); expect(FAX_OUTCOME_UNKNOWN_SENTENCE).toMatch(/Faxage/)
  })
  it("a non-JSON 2xx / 3xx answer (a proxy page, a redirect) is also outcome unknown, not 'try again'", () => {
    for (const status of [200, 204, 301, 302, 307]) expect(faxSendFailureText({ status, json: null }), String(status)).toBe(FAX_OUTCOME_UNKNOWN_SENTENCE)
    expect(faxSendFailureText({ status: 200, json: { success: false } })).toBe("Could not send the fax. Please try again.")
  })
  it("our own answers keep their own words (also on 5xx)", () => {
    expect(faxSendFailureText({ status: 503, json: { error: "Could not check. The fax was NOT sent." } })).toBe("Could not check. The fax was NOT sent.")
    expect(faxSendFailureText({ status: 502, json: { error: "Faxage rejected the request: ERR02" } })).toMatch(/Faxage rejected/)
    expect(faxSendFailureText({ status: 400, json: { error: "A valid fax number is required." } })).toMatch(/valid fax number/)
  })
  it("a 4xx without a body keeps the ordinary fallback", () => {
    expect(faxSendFailureText({ status: 400, json: null })).toBe("Could not send the fax. Please try again.")
    expect(faxSendFailureText({ status: 400, json: {} }, "x")).toBe("x")
  })
})
