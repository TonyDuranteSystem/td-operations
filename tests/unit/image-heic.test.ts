import { describe, it, expect, vi } from "vitest"
import { looksLikeHeic, readableImage, jpegForSaving, jpegNameFor, isHeicByNameOrType } from "@/lib/image-heic"

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


describe("saving an iPhone photo as a JPEG", () => {
  it("renames .heic to .jpg without doubling the extension", () => {
    expect(jpegNameFor("IMG_1857.HEIC")).toBe("IMG_1857.jpg")
    expect(jpegNameFor("passport.heif")).toBe("passport.jpg")
    expect(jpegNameFor("already.jpg")).toBe("already.jpg")
    expect(jpegNameFor("scan")).toBe("scan.jpg")
  })
  it("recognises an iPhone upload from its name or type", () => {
    expect(isHeicByNameOrType("a.heic", null)).toBe(true)
    expect(isHeicByNameOrType("a.bin", "image/heif")).toBe(true)
    expect(isHeicByNameOrType("a.jpg", "image/jpeg")).toBe(false)
  })
  it("converts: new name, JPEG type, JPEG bytes", async () => {
    const r = await jpegForSaving({ name: "IMG_1.HEIC", mimeType: "image/heic", bytes: heicBytes }, async () => jpegBytes)
    expect(r).toMatchObject({ name: "IMG_1.jpg", mimeType: "image/jpeg", converted: true })
    expect(r.bytes).toBe(jpegBytes)
  })
  it("leaves a non-HEIC file alone", async () => {
    const convert = vi.fn(async () => jpegBytes)
    const r = await jpegForSaving({ name: "a.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.4 xxxxxxxxxxxx") }, convert)
    expect(convert).not.toHaveBeenCalled()
    expect(r.converted).toBe(false)
  })
  it("never fails the save: a broken conversion keeps the original", async () => {
    const boom = await jpegForSaving({ name: "x.heic", mimeType: "image/heic", bytes: heicBytes }, async () => { throw new Error("bad heic") })
    expect(boom).toMatchObject({ name: "x.heic", mimeType: "image/heic", converted: false })
    const notJpeg = await jpegForSaving({ name: "x.heic", mimeType: "image/heic", bytes: heicBytes }, async () => Buffer.from("not a jpeg at all"))
    expect(notJpeg.converted).toBe(false)
  })
})
