import { describe, it, expect, vi } from "vitest"
import { looksLikeHeic, readableImage } from "@/lib/image-heic"

const heicBytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(20)])
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])

describe("looksLikeHeic", () => {
  it("knows an iPhone photo by type, by name or by its file signature", () => {
    expect(looksLikeHeic("a.bin", "image/heic", Buffer.alloc(0))).toBe(true)
    expect(looksLikeHeic("IMG_1855.HEIC", null, Buffer.alloc(0))).toBe(true)
    expect(looksLikeHeic("scan", "application/octet-stream", heicBytes)).toBe(true)
  })
  it("leaves other images alone", () => {
    expect(looksLikeHeic("a.jpg", "image/jpeg", jpegBytes)).toBe(false)
    expect(looksLikeHeic("a.pdf", "application/pdf", Buffer.from("%PDF-1.4 xxxxxxxxxx"))).toBe(false)
  })
})

describe("readableImage", () => {
  it("converts HEIC to a JPEG and says so", async () => {
    const convert = vi.fn(async () => jpegBytes)
    const r = await readableImage(heicBytes, "image/heic", "p.heic", convert)
    expect(convert).toHaveBeenCalledOnce()
    expect(r).toEqual({ bytes: jpegBytes, mimeType: "image/jpeg", converted: true })
  })
  it("passes anything else through untouched, without converting", async () => {
    const convert = vi.fn(async () => jpegBytes)
    const r = await readableImage(jpegBytes, "image/jpeg", "p.jpg", convert)
    expect(convert).not.toHaveBeenCalled()
    expect(r.converted).toBe(false)
    expect(r.bytes).toBe(jpegBytes)
  })
})
