import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { getV3BaseUrl } from "@/lib/harbor-compliance/client"

/**
 * Harbor upgraded v1 → v3; registrations (with expiration_date +
 * next_annual_report_due_date) are only reachable on the v3 nested path.
 * getV3BaseUrl derives the v3 host from the configured base so the switch is a
 * single env var rather than a code change.
 */
describe("getV3BaseUrl", () => {
  const saved = { ...process.env }

  beforeEach(() => {
    process.env.HC_CLIENT_ID = "x"
    process.env.HC_CLIENT_SECRET = "x"
    process.env.HC_USERNAME = "x"
    process.env.HC_PASSWORD = "x"
    delete process.env.HC_API_V3_BASE_URL
  })

  afterEach(() => {
    process.env = { ...saved }
  })

  it("swaps /v1 → /v3 on the production base", () => {
    process.env.HC_API_BASE_URL = "https://www.harborcompliance.com/api/v1"
    expect(getV3BaseUrl()).toBe("https://www.harborcompliance.com/api/v3")
  })

  it("swaps /v1 → /v3 on the sandbox base", () => {
    process.env.HC_API_BASE_URL = "https://sandbox-api.harborcompliance.com/api/v1"
    expect(getV3BaseUrl()).toBe("https://sandbox-api.harborcompliance.com/api/v3")
  })

  it("honors an explicit HC_API_V3_BASE_URL override", () => {
    process.env.HC_API_BASE_URL = "https://www.harborcompliance.com/api/v1"
    process.env.HC_API_V3_BASE_URL = "https://custom.example/api/v3"
    expect(getV3BaseUrl()).toBe("https://custom.example/api/v3")
  })

  it("falls back to the default base (v1 → v3) when HC_API_BASE_URL is unset", () => {
    delete process.env.HC_API_BASE_URL
    expect(getV3BaseUrl()).toBe("https://www.harborcompliance.com/api/v3")
  })
})
