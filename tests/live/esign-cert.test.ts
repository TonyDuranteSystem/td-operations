import { describe, it, expect } from "vitest"
import * as fs from "fs"
import { PDFDocument } from "pdf-lib"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { flattenEnvelopeToSignedPdf } from "@/lib/operations/esign"

// Live sandbox check: re-run completion on an already-completed envelope and
// confirm the output PDF = source pages + 1 certificate page. Writes the result
// so it can be eyeballed. NOT part of CI.
const OUT = "/private/tmp/claude-501/-Users-10225office-Developer-td-operations--claude-worktrees-exciting-archimedes-28b4c7/a4b6dcc1-897b-4d74-97ae-18e858fba941/scratchpad/cert-check.pdf"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

describe("esign certificate (live sandbox)", () => {
  it("appends a certificate page to a completed envelope's signed PDF", async () => {
    expect((process.env.NEXT_PUBLIC_SUPABASE_URL || "").includes("xjcxlmlpeywtwkhstjlw")).toBe(true)

    const { data: envs } = await db
      .from("esign_envelopes")
      .select("id, document_name, status, pdf_storage_path")
      .eq("status", "completed")
      .order("created_at", { ascending: false })
      .limit(1)
    const env = envs?.[0]
    expect(env, "need a completed envelope in sandbox").toBeTruthy()

    const { data: srcBlob } = await supabaseAdmin.storage.from("signature-requests").download(env.pdf_storage_path)
    const srcPages = (await PDFDocument.load(new Uint8Array(await srcBlob!.arrayBuffer()))).getPageCount()

    const { signedPath } = await flattenEnvelopeToSignedPdf(env.id)
    const { data: outBlob } = await supabaseAdmin.storage.from("signed-documents").download(signedPath)
    const outBytes = Buffer.from(await outBlob!.arrayBuffer())
    fs.writeFileSync(OUT, outBytes)
    const outPages = (await PDFDocument.load(outBytes)).getPageCount()

    console.warn(`source pages=${srcPages}, signed+cert pages=${outPages}, doc="${env.document_name}", out=${OUT}`)
    expect(outPages).toBe(srcPages + 1) // exactly one certificate page appended
  }, 90000)
})
