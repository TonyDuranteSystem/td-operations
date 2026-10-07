import { describe, it, expect } from "vitest"
import { decideAiApply } from "@/lib/inbox/whatsapp-ai-apply"

const base = { mode: "polish" as const, sentText: "ciao stefano", currentText: "ciao stefano", requestGroupId: "g1", currentGroupId: "g1", requestId: 3, currentRequestId: 3, changed: true }

describe("decideAiApply — a late AI answer must never overwrite or misplace what was typed", () => {
  it("applies when nothing moved", () => {
    expect(decideAiApply(base)).toEqual({ apply: true })
  })
  it("drops silently when the staff member opened another chat", () => {
    expect(decideAiApply({ ...base, currentGroupId: "g2" })).toEqual({ apply: false, reason: "other_chat", notice: null })
  })
  it("drops silently when a newer click took over", () => {
    expect(decideAiApply({ ...base, currentRequestId: 4 })).toEqual({ apply: false, reason: "superseded", notice: null })
  })
  it("does not apply, and says so, when he kept typing", () => {
    const d = decideAiApply({ ...base, currentText: "ciao stefano, come stai" })
    expect(d).toMatchObject({ apply: false, reason: "box_changed" })
    expect((d as { notice: string }).notice).toContain("was not applied")
  })
  it("treats a Worker draft merged in during the wait the same way (the box is no longer what was sent)", () => {
    expect(decideAiApply({ ...base, currentText: "ciao stefano\n\nDraft from the Worker" })).toMatchObject({ apply: false, reason: "box_changed" })
  })
  it("polish that changed nothing is reported, not applied", () => {
    const d = decideAiApply({ ...base, changed: false })
    expect(d).toMatchObject({ apply: false, reason: "no_change" })
    expect((d as { notice: string }).notice).toContain("already reads well")
  })
  it("a draft into an empty box applies, and `changed` does not matter for drafts", () => {
    expect(decideAiApply({ ...base, mode: "draft", sentText: "", currentText: "", changed: undefined })).toEqual({ apply: true })
  })
  it("a draft is dropped if he typed something while it was being written", () => {
    expect(decideAiApply({ ...base, mode: "draft", sentText: "", currentText: "ciao", changed: undefined })).toMatchObject({ apply: false, reason: "box_changed" })
  })
  it("chat switch wins over every other reason", () => {
    expect(decideAiApply({ ...base, currentGroupId: "g2", currentRequestId: 9, currentText: "x" })).toMatchObject({ reason: "other_chat" })
  })
})
