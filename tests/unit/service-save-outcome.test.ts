import { describe, it, expect } from "vitest"
import { saveOutcome } from "@/lib/services/save-outcome"

describe("saveOutcome — what the service editor does after Save", () => {
  it("a clean save is 'saved' with the service's address", () => {
    expect(saveOutcome({ ok: true, service: { id: "1", slug: "apostille" } }, "new")).toEqual({ kind: "saved", slug: "apostille" })
    expect(saveOutcome({ ok: true, service: { id: "1", slug: "apostille" } }, "edit")).toEqual({ kind: "saved", slug: "apostille" })
  })

  it("a NEW service whose row was created but a later part failed is 'half_saved', so the editor can open it for editing", () => {
    const out = saveOutcome({ ok: false, error: "Workflow save failed", service: { id: "1", slug: "apostille" } }, "new")
    expect(out.kind).toBe("half_saved")
    if (out.kind !== "half_saved") return
    expect(out.slug).toBe("apostille")
    expect(out.message).toContain("Workflow save failed")
    expect(out.message).toContain("was created")
  })

  it("an EXISTING service that failed to save stays a plain failure (its edit page is already open)", () => {
    expect(saveOutcome({ ok: false, error: "Nope", service: { id: "1", slug: "apostille" } }, "edit")).toEqual({ kind: "failed", message: "Nope" })
  })

  it("a failure before anything was written is a plain failure", () => {
    expect(saveOutcome({ ok: false, error: "Name is required." }, "new")).toEqual({ kind: "failed", message: "Name is required." })
  })

  it("a missing or blank error text gets a safe default", () => {
    expect(saveOutcome({ ok: false }, "new")).toEqual({ kind: "failed", message: "Save failed." })
    expect(saveOutcome({ ok: false, error: "   " }, "new")).toEqual({ kind: "failed", message: "Save failed." })
  })

  it("ok without a service (should not happen) is not reported as saved", () => {
    expect(saveOutcome({ ok: true }, "new")).toEqual({ kind: "failed", message: "Save failed." })
  })
})
