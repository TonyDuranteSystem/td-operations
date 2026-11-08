/**
 * Production end-to-end test 2026-11-07 (dev job eaa4747e): an unrelated file chosen as "Other document" opened the lock of "State Dissolution Filing".
 * lockedStepUploadProblem — against a small stand-in database — refuses a wrong-type file on a LOCKED step with a typed box, and changes nothing else.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const fx = vi.hoisted(() => ({
  stage: null as Record<string, unknown> | null,
  stageError: false,
  displayName: "Certificate of Dissolution" as string | null,
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {}
      b.select = () => b
      b.eq = () => b
      b.limit = async () => (fx.stageError ? { data: null, error: { message: "boom" } } : { data: fx.stage ? [fx.stage] : [], error: null })
      b.maybeSingle = async () => (table === "catalog_entries" ? { data: fx.displayName ? { display_name: fx.displayName } : null, error: null } : { data: null, error: null })
      return b
    },
  },
}))

import { lockedStepUploadProblem, boxTypeOfLayout } from "@/lib/flows/flow-upload-type"

const layoutWith = (documentType?: string) => ({ components: [{ type: "document_upload", label: "Upload", ...(documentType ? { documentType } : {}) }] })

beforeEach(() => {
  fx.stage = { requires_document_to_advance: true, stage_layout: layoutWith("certificate_of_dissolution") }
  fx.stageError = false
  fx.displayName = "Certificate of Dissolution"
})

const input = (chosenSlug: string | null) => ({ serviceType: "Company Closure", stageName: "State Dissolution Filing", chosenSlug })

describe("lockedStepUploadProblem", () => {
  it("an unrelated type on the locked step is refused, naming the type that is needed", async () => {
    const msg = await lockedStepUploadProblem(input("other_document"))
    expect(msg).toContain("Certificate of Dissolution")
    expect(msg).toContain("only that kind of file")
  })

  it("the type the box asks for passes", async () => {
    expect(await lockedStepUploadProblem(input("certificate_of_dissolution"))).toBeNull()
  })

  it("a step that is not locked takes any type (unchanged)", async () => {
    fx.stage = { requires_document_to_advance: false, stage_layout: layoutWith("certificate_of_dissolution") }
    expect(await lockedStepUploadProblem(input("other_document"))).toBeNull()
  })

  it("a locked step whose box is typed 'other document' (Company Change Name) or untyped (DBA) takes any type (unchanged)", async () => {
    fx.stage = { requires_document_to_advance: true, stage_layout: layoutWith("other_document") }
    expect(await lockedStepUploadProblem(input("passport"))).toBeNull()
    fx.stage = { requires_document_to_advance: true, stage_layout: layoutWith(undefined) }
    expect(await lockedStepUploadProblem(input("passport"))).toBeNull()
  })

  it("an unknown step, or no step name, checks nothing", async () => {
    fx.stage = null
    expect(await lockedStepUploadProblem(input("other_document"))).toBeNull()
    expect(await lockedStepUploadProblem({ serviceType: null, stageName: null, chosenSlug: "x" })).toBeNull()
  })

  it("a step that cannot be read refuses the upload (fails closed) rather than letting an unchecked file through", async () => {
    fx.stageError = true
    expect(await lockedStepUploadProblem(input("other_document"))).toContain("nothing was uploaded")
  })

  it("the type's name falls back to its words when the catalog row has no name", async () => {
    fx.displayName = null
    expect(await lockedStepUploadProblem(input("other_document"))).toContain("certificate of dissolution")
  })
})

describe("boxTypeOfLayout", () => {
  it("the one type of a stage's boxes, else null", () => {
    expect(boxTypeOfLayout(layoutWith("a"))).toBe("a")
    expect(boxTypeOfLayout({ components: [{ type: "document_upload", documentType: "a" }, { type: "document_upload", documentType: "b" }] })).toBeNull()
    expect(boxTypeOfLayout({ components: [{ type: "chat" }] })).toBeNull()
    expect(boxTypeOfLayout(null)).toBeNull()
  })
})
