import { describe, it, expect, vi } from "vitest"

const createSignedUrl = vi.fn()
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { storage: { from: () => ({ createSignedUrl }) } },
}))

import {
  isValidWhatsAppAttachmentPath,
  resolveWhatsAppAttachmentUrl,
  WHATSAPP_ATTACHMENT_URL_TTL_SECONDS,
} from "@/lib/messaging/attachment-staging"

describe("isValidWhatsAppAttachmentPath", () => {
  it("accepts a server-minted whatsapp-new path", () => {
    expect(isValidWhatsAppAttachmentPath("whatsapp-new/550e8400-e29b-41d4-a716-446655440000.jpg")).toBe(true)
  })

  it("rejects a worker-chat path (different feature's prefix)", () => {
    expect(isValidWhatsAppAttachmentPath("worker-chat/550e8400-e29b-41d4-a716-446655440000.jpg")).toBe(false)
  })

  it("rejects path traversal", () => {
    expect(isValidWhatsAppAttachmentPath("whatsapp-new/../../etc/passwd")).toBe(false)
  })

  it("rejects a non-UUID name", () => {
    expect(isValidWhatsAppAttachmentPath("whatsapp-new/not-a-uuid.jpg")).toBe(false)
  })
})

describe("resolveWhatsAppAttachmentUrl", () => {
  it("returns null without calling storage for an invalid path", async () => {
    const url = await resolveWhatsAppAttachmentUrl("worker-chat/550e8400-e29b-41d4-a716-446655440000.jpg")
    expect(url).toBeNull()
    expect(createSignedUrl).not.toHaveBeenCalled()
  })

  it("signs a valid path with the expected TTL", async () => {
    createSignedUrl.mockResolvedValue({ data: { signedUrl: "https://signed.example/x" }, error: null })
    const path = "whatsapp-new/550e8400-e29b-41d4-a716-446655440000.jpg"
    const url = await resolveWhatsAppAttachmentUrl(path)
    expect(url).toBe("https://signed.example/x")
    expect(createSignedUrl).toHaveBeenCalledWith(path, WHATSAPP_ATTACHMENT_URL_TTL_SECONDS)
  })

  it("returns null when signing fails", async () => {
    createSignedUrl.mockResolvedValue({ data: null, error: { message: "not found" } })
    const url = await resolveWhatsAppAttachmentUrl("whatsapp-new/550e8400-e29b-41d4-a716-446655440000.jpg")
    expect(url).toBeNull()
  })
})
