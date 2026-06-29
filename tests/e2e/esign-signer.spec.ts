/**
 * Real-browser E2E for the e-sign SIGNER flow (the public, no-login path).
 * Drives the actual signer page in Chromium against a LOCAL dev server
 * (worktree code) + the sandbox DB: pdfjs renders the PDF, the signer draws a
 * signature on the canvas, and submits. Verifies the document completes.
 *
 * Run: dev server on :3000, then
 *   npx playwright test esign-signer --project=chromium
 */
import { test, expect } from "@playwright/test"
import { randomBytes } from "crypto"
import { PDFDocument } from "pdf-lib"
import { createClient } from "@supabase/supabase-js"
import { config as loadEnv } from "dotenv"

loadEnv({ path: ".env.local" })

const BASE = "http://localhost:3000"
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ""
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ""
const sb = createClient(url, key)
const rand = (n = 16) => randomBytes(n).toString("base64url")

let envelopeId = ""
let signUrl = ""

test.beforeAll(async () => {
  if (!url.includes("xjcxlmlpeywtwkhstjlw")) throw new Error("not sandbox")
  const doc = await PDFDocument.create()
  doc.addPage([612, 792])
  const pdfBytes = Buffer.from(await doc.save())

  const token = rand(12)
  const storagePath = `esign/${token}/e2e.pdf`
  await sb.storage.from("signature-requests").upload(storagePath, pdfBytes, { contentType: "application/pdf", upsert: true })

  const { data: env } = await sb
    .from("esign_envelopes")
    .insert({ token, access_code: rand(), origin: "staff", document_name: "E2E BROWSER TEST (auto-cleanup)", pdf_storage_path: storagePath, page_count: 1, routing_order: "parallel", status: "sent", total_signers: 1 })
    .select("id")
    .single()
  envelopeId = env!.id

  const signerToken = rand(18)
  const signerCode = rand()
  const { data: signer } = await sb
    .from("esign_signers")
    .insert({ envelope_id: envelopeId, signer_index: 0, name: "E2E Signer", access_code: signerCode, token: signerToken, status: "sent", sent_at: new Date().toISOString() })
    .select("id")
    .single()

  await sb.from("esign_fields").insert({ envelope_id: envelopeId, signer_id: signer!.id, field_type: "signature", page_index: 0, pos_x: 0.15, pos_y: 0.72, width: 0.38, height: 0.09, required: true })

  signUrl = `${BASE}/sign/${signerToken}/${signerCode}`
})

test.afterAll(async () => {
  if (envelopeId) await sb.from("esign_envelopes").delete().eq("id", envelopeId) // cascades signer/fields/events
})

test("signer signs the document end-to-end in the browser", async ({ page }) => {
  await page.goto(signUrl, { waitUntil: "domcontentloaded" })

  // The signature field button appears once pdfjs has rendered the page + overlay.
  const signField = page.getByRole("button", { name: "Sign", exact: true })
  await expect(signField).toBeVisible({ timeout: 90000 })
  await signField.click()

  // Draw on the signature-pad canvas inside the modal.
  const modal = page.locator("div.fixed.inset-0")
  const canvas = modal.locator("canvas")
  await expect(canvas).toBeVisible({ timeout: 10000 })
  await page.waitForTimeout(300) // let signature_pad initialise
  const box = (await canvas.boundingBox())!
  await page.mouse.move(box.x + 25, box.y + box.height * 0.6)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.25)
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.8)
  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.3)
  await page.mouse.up()

  await modal.getByRole("button", { name: "Apply" }).click()
  await expect(modal).toBeHidden({ timeout: 5000 })

  await page.getByPlaceholder("Type your full legal name").fill("E2E Signer")
  await page.getByRole("checkbox").first().check()

  await page.getByRole("button", { name: "Sign & Submit" }).click()

  await expect(page.getByText("Document signed")).toBeVisible({ timeout: 30000 })

  // Confirm in the DB the envelope actually completed.
  const { data: env } = await sb.from("esign_envelopes").select("status, signed_pdf_path").eq("id", envelopeId).maybeSingle()
  expect(env?.status).toBe("completed")
  expect(env?.signed_pdf_path).toBeTruthy()
})
