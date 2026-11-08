/**
 * The approved-answers panel must never wait forever with no way out (dev job 7df278cd, follow-up to Shipment 2).
 * No React render harness here, so these pin the SOURCE; the behaviour was walked in the browser against the sandbox.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"

const src = readFileSync("components/flows/tax-save-panel.tsx", "utf8")

describe("tax save panel: always a way out", () => {
  it("a save that never started (the request failed or was cut short) offers Retry saving instead of a spinner", () => {
    expect(src).toContain("const notStarted = st.state === 'not_saved' && autoTried && busy === null")
    expect(src).toContain("data-testid={notStarted ? 'tax-save-not-started' : 'tax-save-stalled'}")
  })
  it("a save that has been 'running' longer than the panel waits offers Retry saving", () => {
    expect(src).toContain("const stalled = st.state === 'saving' && polls >= MAX_POLLS && busy === null")
  })
  it("the spinner is hidden in both of those cases", () => {
    expect(src).toContain("(st.state === 'saving' || st.state === 'not_saved') && !notStarted && !stalled")
  })
  it("the 'tried once' flag and the check count are state (the screen depends on them), and a Retry starts the count over", () => {
    expect(src).toContain("const [autoTried, setAutoTried] = useState(false)")
    expect(src).toContain("const [polls, setPolls] = useState(0)")
    expect(src).toMatch(/setBusy\(what\)\s*setError\(null\)\s*setPolls\(0\)/)
    expect(src).not.toContain("useRef")
  })
  it("the failed block no longer promises a retry or an alert nothing performs", () => {
    expect(src).not.toMatch(/keeps trying by itself/)
    expect(src).not.toMatch(/team was alerted/)
    expect(src).toContain("The system will try again shortly.")
    expect(src).toContain("The system is not trying again by itself. Press Retry saving.")
  })
})
