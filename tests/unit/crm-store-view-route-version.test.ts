import { describe, it, expect, vi, beforeEach } from "vitest"

const readFileForStaff = vi.fn()
const readVersionForStaff = vi.fn()
const readHeadForStaff = vi.fn()
vi.mock("@/app/api/crm-store/browse/_auth", () => ({ denyUnlessStoreStaff: async () => null, denyUnlessAreaAccess: async () => null }))
vi.mock("@/lib/crm-store/browse", () => ({ readFileForStaff: (...a: unknown[]) => readFileForStaff(...a), readVersionForStaff: (...a: unknown[]) => readVersionForStaff(...a), readHeadForStaff: (...a: unknown[]) => readHeadForStaff(...a) }))

import { GET } from "@/app/api/crm-store/browse/file/[id]/view/route"
import { NextRequest } from "next/server"

const FILE = "11111111-1111-4111-8111-111111111111"
const VER = "22222222-2222-4222-8222-222222222222"
const call = (qs = "") => GET(new NextRequest(`http://x/api/crm-store/browse/file/${FILE}/view${qs}`), { params: { id: FILE } })
const md = (name: string) => ({ name, mimeType: "text/markdown", bytes: Buffer.from("# hello") })

const headOf = (name: string, mimeType: string | null, bytes: Buffer) => ({ name, mimeType, size: bytes.length, head: bytes.subarray(0, 65536) })
beforeEach(() => { readFileForStaff.mockReset(); readVersionForStaff.mockReset(); readHeadForStaff.mockReset() })

describe("simplified view of a file or of one older saved copy", () => {
  it("no version: reads the current copy", async () => {
    readHeadForStaff.mockResolvedValue(headOf("a.md", "text/markdown", Buffer.from("# hello")))
    readFileForStaff.mockResolvedValue(md("a.md"))
    const r = await call()
    expect(r.status).toBe(200)
    expect(readFileForStaff).toHaveBeenCalledWith(FILE)
    expect(readVersionForStaff).not.toHaveBeenCalled()
  })
  it("with ?version=: reads THAT copy of THIS file", async () => {
    readVersionForStaff.mockResolvedValue(md("v1 - a.md"))
    const r = await call(`?version=${VER}`)
    expect(r.status).toBe(200)
    expect(readVersionForStaff).toHaveBeenCalledWith(FILE, VER)
    expect(readFileForStaff).not.toHaveBeenCalled()
    expect(await r.text()).toContain("hello")
  })
  it("a version that is not a uuid is refused before anything is read", async () => {
    for (const bad of ["abc", "1 OR 1=1", "../x", ""]) {
      const r = await call(`?version=${encodeURIComponent(bad)}`)
      expect(r.status, bad).toBe(400)
    }
    expect(readVersionForStaff).not.toHaveBeenCalled()
    expect(readFileForStaff).not.toHaveBeenCalled()
  })
  it("a version of another file (the reader refuses) is a plain not-available answer", async () => {
    readVersionForStaff.mockRejectedValue(new Error("store browse: version not found"))
    const r = await call(`?version=${VER}`)
    expect(r.status).toBe(404)
  })
  it("the script-free headers still apply", async () => {
    readVersionForStaff.mockResolvedValue(md("v1 - a.md"))
    const r = await call(`?version=${VER}`)
    expect(r.headers.get("content-security-policy")).toMatch(/default-src 'none'/)
    expect(r.headers.get("content-security-policy")).toMatch(/sandbox/)
  })
  it("every other file still gets a page: a file nothing can draw gets the details page, and is never fully read", async () => {
    readHeadForStaff.mockResolvedValue(headOf("blob.bin", "application/octet-stream", Buffer.from([0, 255, 0, 1, 2, 3])))
    const r = await call()
    expect(r.status).toBe(200)
    expect(await r.text()).toContain("no picture to show")
    expect(readFileForStaff).not.toHaveBeenCalled()
  })
  it("?mode=html serves an HTML file as the real page inside its own sandbox", async () => {
    const page = Buffer.from("<h1>Mockup</h1><script>1</script>")
    readHeadForStaff.mockResolvedValue(headOf("mockup.html", "text/html", page))
    readFileForStaff.mockResolvedValue({ name: "mockup.html", mimeType: "text/html", bytes: page })
    const r = await call("?mode=html")
    expect(r.status).toBe(200)
    expect(r.headers.get("content-type")).toMatch(/text\/html/)
    expect(r.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-forms allow-modals")
    expect(await r.text()).toContain("<script>")
  })
  it("?mode=html refuses a file that is not HTML and an older copy", async () => {
    readHeadForStaff.mockResolvedValue(headOf("notes.txt", "text/plain", Buffer.from("hi")))
    expect((await call("?mode=html")).status).toBe(400)
    expect((await call(`?mode=html&version=${VER}`)).status).toBe(400)
    expect(readFileForStaff).not.toHaveBeenCalled()
  })
  it("?mode=html refuses a page that is too large to show", async () => {
    readHeadForStaff.mockResolvedValue({ name: "big.html", mimeType: "text/html", size: 20 * 1024 * 1024, head: Buffer.from("<p>") })
    expect((await call("?mode=html")).status).toBe(413)
    expect(readFileForStaff).not.toHaveBeenCalled()
  })
})
