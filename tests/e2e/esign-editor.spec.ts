/**
 * Real-browser E2E for the STAFF e-sign EDITOR. Logs in as an ephemeral sandbox
 * staff user, uploads a PDF, places a signature field by clicking the rendered
 * page, names a signer, and creates the envelope — verifying it lands in the DB.
 *
 * Run: dev server on :3000, then
 *   npx playwright test esign-editor --project=chromium
 */
import { test, expect } from "@playwright/test"
import { PDFDocument } from "pdf-lib"
import { createClient } from "@supabase/supabase-js"
import { config as loadEnv } from "dotenv"

loadEnv({ path: ".env.local" })

const BASE = "http://localhost:3000"
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || "", process.env.SUPABASE_SERVICE_ROLE_KEY || "")
const STAFF_EMAIL = `qa-esign-staff-${Date.now()}@example.com`
const STAFF_PW = "QaEsignStaff!2026"
const DOC_NAME = `QA EDITOR TEST ${Date.now()}`

let staffUserId = ""
let pdfBuffer: Buffer

test.beforeAll(async () => {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL || "").includes("xjcxlmlpeywtwkhstjlw")) throw new Error("not sandbox")
  const { data, error } = await sb.auth.admin.createUser({
    email: STAFF_EMAIL,
    password: STAFF_PW,
    email_confirm: true,
    app_metadata: { role: "admin" }, // non-client → isDashboardUser passes
  })
  if (error) throw error
  staffUserId = data.user!.id
  const doc = await PDFDocument.create()
  doc.addPage([612, 792])
  pdfBuffer = Buffer.from(await doc.save())
})

test.afterAll(async () => {
  await sb.from("esign_envelopes").delete().eq("document_name", DOC_NAME)
  if (staffUserId) await sb.auth.admin.deleteUser(staffUserId)
})

test("staff creates an envelope in the editor end-to-end", async ({ page }) => {
  test.setTimeout(120000) // dev-mode pdfjs compile + render is slow
  page.on("pageerror", e => console.warn("PAGEERROR:", e.message))
  page.on("console", m => { if (m.type() === "error") console.warn("CONSOLE-ERR:", m.text().slice(0, 300)) })
  // 1. Log in as staff.
  await page.goto(`${BASE}/login`)
  await page.fill("#email", STAFF_EMAIL)
  await page.fill("#password", STAFF_PW)
  await page.click('button[type="submit"]')
  await page.waitForURL(u => !u.pathname.includes("/login"), { timeout: 30000 })
  await page.waitForLoadState("networkidle") // let the post-login redirect settle

  // 2. Open the editor and confirm we're actually on it (not bounced home).
  await page.goto(`${BASE}/tools/esign/new`, { waitUntil: "domcontentloaded" })
  await expect(page.getByRole("heading", { name: "New E-Sign envelope" })).toBeVisible({ timeout: 30000 })

  // 3. Upload via the native file chooser (reliably fires React's onChange; plain
  //    setInputFiles did not trigger it here).
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.locator('input[accept="application/pdf"]').click(),
  ])
  await chooser.setFiles({ name: `${DOC_NAME}.pdf`, mimeType: "application/pdf", buffer: pdfBuffer })

  // 4. Wait for pdfjs to render the page, then click to drop a signature field.
  const pageEl = page.locator('[data-page="0"]')
  await expect(pageEl).toBeVisible({ timeout: 90000 })
  await page.waitForTimeout(500)
  await pageEl.click({ position: { x: 120, y: 380 } })

  // 5. Name the signer.
  await page.getByPlaceholder("Signer 1 name").fill("QA Signer")

  // 6. Create.
  await page.getByRole("button", { name: /Create & get signing link/ }).click()

  // 7. The result view appears with the signing link (in a read-only input).
  await expect(page.getByText("Envelope created")).toBeVisible({ timeout: 30000 })
  await expect(page.locator("input[readonly]").first()).toHaveValue(/\/sign\//)

  // 8. Verify in the DB.
  const { data: env } = await sb.from("esign_envelopes").select("id, status, total_signers, origin").eq("document_name", DOC_NAME).maybeSingle()
  expect(env).toBeTruthy()
  expect(env!.origin).toBe("staff")
  expect(env!.total_signers).toBe(1)
  const { data: fields } = await sb.from("esign_fields").select("field_type").eq("envelope_id", env!.id)
  expect((fields ?? []).some(f => f.field_type === "signature")).toBe(true)
})
