import { describe, it, expect } from "vitest"
import {
  buildOutboundPath,
  kindForMime,
  isDangerousFileName,
  validateOutboundAttachment,
  MAX_ATTACHMENT_BYTES,
} from "@/lib/messaging/wabridge-attachment"

describe("buildOutboundPath", () => {
  it("is deterministic from channel + client message id + mime, matching the SQL formula", () => {
    expect(buildOutboundPath("ch1", "msg1", "image/jpeg")).toBe("outbound/ch1/msg1.jpg")
  })
  it("is the same for two calls with the same inputs (a retry can never diverge)", () => {
    expect(buildOutboundPath("4cb021ab-1731-49b8-9d27-6483d2dae4f1", "abc-123", "audio/mp4")).toBe(
      buildOutboundPath("4cb021ab-1731-49b8-9d27-6483d2dae4f1", "abc-123", "audio/mp4")
    )
  })
  it("uses a real extension so the WhatsApp program accepts the file — an unknown mime falls back safely", () => {
    expect(buildOutboundPath("ch1", "msg1", "audio/mp4")).toBe("outbound/ch1/msg1.m4a")
    expect(buildOutboundPath("ch1", "msg1", "video/mp4")).toBe("outbound/ch1/msg1.mp4")
    expect(buildOutboundPath("ch1", "msg1", "application/pdf")).toBe("outbound/ch1/msg1.pdf")
    expect(buildOutboundPath("ch1", "msg1", "application/zip")).toBe("outbound/ch1/msg1.bin")
    expect(buildOutboundPath("ch1", "msg1", null)).toBe("outbound/ch1/msg1.bin")
  })
})

describe("kindForMime", () => {
  it("maps audio to voice", () => {
    expect(kindForMime("audio/mp4")).toBe("voice")
    expect(kindForMime("audio/ogg")).toBe("voice")
  })
  it("maps images, video, documents", () => {
    expect(kindForMime("image/jpeg")).toBe("image")
    expect(kindForMime("video/mp4")).toBe("video")
    expect(kindForMime("application/pdf")).toBe("document")
  })
  it("is case-insensitive and trims", () => {
    expect(kindForMime("  AUDIO/MP4  ")).toBe("voice")
  })
  it("returns null for unknown or empty mime", () => {
    expect(kindForMime("application/x-msdownload")).toBeNull()
    expect(kindForMime("")).toBeNull()
    expect(kindForMime(null)).toBeNull()
    expect(kindForMime(undefined)).toBeNull()
  })
})

describe("isDangerousFileName", () => {
  it("flags known dangerous extensions, case-insensitively", () => {
    expect(isDangerousFileName("invoice.exe")).toBe(true)
    expect(isDangerousFileName("invoice.EXE")).toBe(true)
    expect(isDangerousFileName("run.sh")).toBe(true)
    expect(isDangerousFileName("setup.msi")).toBe(true)
    expect(isDangerousFileName("bad.scr")).toBe(true)
  })
  it("does not flag ordinary files", () => {
    expect(isDangerousFileName("invoice.pdf")).toBe(false)
    expect(isDangerousFileName("photo.jpg")).toBe(false)
    expect(isDangerousFileName("note.txt")).toBe(false)
  })
  it("does not flag a file with no extension", () => {
    expect(isDangerousFileName("README")).toBe(false)
  })
  it("handles a doubled extension by checking the LAST one", () => {
    expect(isDangerousFileName("invoice.pdf.exe")).toBe(true) // the actual danger — a disguised executable
    expect(isDangerousFileName("archive.tar.gz")).toBe(false)
  })
  it("handles empty/null safely", () => {
    expect(isDangerousFileName("")).toBe(false)
    expect(isDangerousFileName(null)).toBe(false)
    expect(isDangerousFileName(undefined)).toBe(false)
  })
})

describe("validateOutboundAttachment", () => {
  const base = { fileName: "note.mp3", fileSize: 1000, mimeType: "audio/mpeg" }
  it("accepts a normal voice file", () => {
    expect(validateOutboundAttachment(base)).toEqual({ ok: true, kind: "voice" })
  })
  it("refuses a dangerous file name even with a media mime type (a renamed file can lie about mime)", () => {
    const r = validateOutboundAttachment({ ...base, fileName: "invoice.exe" })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/security/i)
  })
  it("refuses an unsupported mime type", () => {
    const r = validateOutboundAttachment({ ...base, mimeType: "application/zip" })
    expect(r.ok).toBe(false)
  })
  it("refuses a zero or negative size", () => {
    expect(validateOutboundAttachment({ ...base, fileSize: 0 }).ok).toBe(false)
    expect(validateOutboundAttachment({ ...base, fileSize: -5 }).ok).toBe(false)
    expect(validateOutboundAttachment({ ...base, fileSize: NaN }).ok).toBe(false)
  })
  it("refuses a file over the size ceiling, accepts one at the ceiling", () => {
    expect(validateOutboundAttachment({ ...base, fileSize: MAX_ATTACHMENT_BYTES + 1 }).ok).toBe(false)
    expect(validateOutboundAttachment({ ...base, fileSize: MAX_ATTACHMENT_BYTES }).ok).toBe(true)
  })
})
