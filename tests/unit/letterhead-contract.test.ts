import { describe, it, expect } from "vitest"
import { renderLetterPdf } from "@/lib/pdf/letter-pdf"
import { extractTextFromBuffer } from "@/lib/ai-agent/slack-file-reader"

/**
 * THE LETTERHEAD CONTRACT — the gate the fix was missing.
 *
 * Luca, 2026-07-27: asked repeatedly for a letter for Lepren LLC WITHOUT the
 * "Tony Durante LLC" header and got it every time. Two bugs sat behind that; the
 * dangerous half is the fix itself.
 *
 * `renderLetterPdf` now reads: absent ⇒ firm default, `''` or `null` ⇒ bare. The
 * `pdf_create` handler MUST therefore pass `letterhead` through UNCHANGED. Its three
 * sibling options are all normalised (`title: title ?? null` etc.), so the obvious
 * "consistency cleanup" — making letterhead match them — converts "caller said
 * nothing" into "caller asked for none" and silently strips the firm's header off
 * EVERY client-facing letter. The previous test suite asserted only that the output
 * had one page, which is true of every possible implementation including that one.
 *
 * These tests read the rendered TEXT BACK OUT of the PDF, so they fail on the thing
 * that matters — what a client actually sees on the page.
 */

async function headerTextOf(opts: Record<string, unknown>): Promise<string> {
  const bytes = await renderLetterPdf({ body: "Dear client, this is the body.", ...opts } as never)
  const extracted = await extractTextFromBuffer(Buffer.from(bytes), "pdf", "letter.pdf")
  return (typeof extracted === "string" ? extracted : JSON.stringify(extracted)).replace(/\s+/g, " ")
}

const FIRM = "Tony Durante LLC"

describe("letterhead contract (rendered output, not page count)", () => {
  it("OMITTED ⇒ the firm's letterhead — the default must survive the fix", async () => {
    expect(await headerTextOf({})).toContain(FIRM)
  })

  it('EMPTY STRING ⇒ bare — this is what Luca asked for', async () => {
    expect(await headerTextOf({ letterhead: "" })).not.toContain(FIRM)
  })

  it("NULL ⇒ bare — it used to fold into the default, which was the bug", async () => {
    expect(await headerTextOf({ letterhead: null })).not.toContain(FIRM)
  })

  it("A STRING ⇒ that string alone, with no firm header alongside it", async () => {
    const text = await headerTextOf({ letterhead: "Acme Corp" })
    expect(text).toContain("Acme Corp")
    expect(text).not.toContain(FIRM)
  })

  it("keeps the body in every case — suppressing the header must not eat the letter", async () => {
    for (const opts of [{}, { letterhead: "" }, { letterhead: null }, { letterhead: "Acme Corp" }]) {
      expect(await headerTextOf(opts)).toContain("this is the body")
    }
  })
})

describe("pdf_create hands letterhead to the renderer UNCHANGED", () => {
  it("does not normalise an absent letterhead into null (that would strip every header)", async () => {
    // Reads the handler's own source rather than mocking the MCP server: the defect
    // is a one-token edit (`letterhead` → `letterhead ?? null`) whose blast radius is
    // every generated document, and the point is to make that edit impossible to land
    // quietly. The four render tests above prove the renderer's half of the contract.
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("lib/mcp/tools/documents-generate.ts", "utf8")
    expect(src).not.toMatch(/letterhead:\s*letterhead\s*\?\?/)
    expect(src).toMatch(/^\s*letterhead,\s*$/m)
  })

  it("accepts null as well as an empty string, so the honest attempt is not rejected", async () => {
    const { z } = await import("zod")
    // Mirrors the registered schema. A bare z.string().optional() REJECTS null, so an
    // assistant reaching for null to mean "no header" failed validation and the header
    // survived — the user-visible symptom being indistinguishable from the original bug.
    const schema = z.string().nullable().optional()
    expect(schema.safeParse(null).success).toBe(true)
    expect(schema.safeParse("").success).toBe(true)
    expect(schema.safeParse(undefined).success).toBe(true)
    const src = readFileSyncSafe("lib/mcp/tools/documents-generate.ts")
    expect(src).toMatch(/letterhead:\s*z[\s\S]{0,80}?\.nullable\(\)/)
  })
})

function readFileSyncSafe(p: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("node:fs").readFileSync(p, "utf8")
}
