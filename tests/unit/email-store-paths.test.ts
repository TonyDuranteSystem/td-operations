import { describe, it, expect } from "vitest"
import {
  bodyStoragePath,
  attachmentStoragePath,
  captureStatus,
  assertMailbox,
} from "@/lib/email-store/paths"

describe("email-store storage paths", () => {
  it("builds a body path under the mailbox/message prefix", () => {
    expect(bodyStoragePath("support", "18f2ab9c")).toBe("support/18f2ab9c/body.html")
  })

  it("attachment path never contains the sender filename and is stable per id", () => {
    const p = attachmentStoragePath("support", "18f2ab9c", "ANGjdJ_att-0001")
    expect(p.startsWith("support/18f2ab9c/att/")).toBe(true)
    // opaque 32-hex, no filename leaked
    expect(p).toMatch(/^support\/18f2ab9c\/att\/[0-9a-f]{32}$/)
    // deterministic
    expect(attachmentStoragePath("support", "18f2ab9c", "ANGjdJ_att-0001")).toBe(p)
    // different attachment id → different path
    expect(attachmentStoragePath("support", "18f2ab9c", "ANGjdJ_att-0002")).not.toBe(p)
  })

  it("rejects a hostile message_id (path traversal fail-closed)", () => {
    expect(() => bodyStoragePath("support", "../../signed-contracts")).toThrow()
    expect(() => attachmentStoragePath("support", "a/../b", "att1")).toThrow()
  })

  it("rejects an unknown mailbox", () => {
    expect(() => bodyStoragePath("marketing", "abc")).toThrow()
    expect(() => assertMailbox("client")).toThrow()
  })

  it("rejects an empty attachment id", () => {
    expect(() => attachmentStoragePath("support", "abc", "")).toThrow()
  })
})

describe("email-store capture completeness", () => {
  it("is complete only when raw stored AND all attachments stored", () => {
    expect(captureStatus({ bodyStored: true, attachmentsExpected: 0, attachmentsStored: 0 })).toBe("complete")
    expect(captureStatus({ bodyStored: true, attachmentsExpected: 3, attachmentsStored: 3 })).toBe("complete")
  })

  it("is pending when the body is missing", () => {
    expect(captureStatus({ bodyStored: false, attachmentsExpected: 0, attachmentsStored: 0 })).toBe("pending")
  })

  it("is pending when any attachment is missing (partial write not trusted)", () => {
    expect(captureStatus({ bodyStored: true, attachmentsExpected: 5, attachmentsStored: 2 })).toBe("pending")
  })

  it("throws on negative counts", () => {
    expect(() => captureStatus({ bodyStored: true, attachmentsExpected: -1, attachmentsStored: 0 })).toThrow()
  })
})
