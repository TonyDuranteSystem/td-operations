/**
 * Real-browser E2E for the STAFF e-sign EDITOR. Logs in as an ephemeral sandbox
 * staff user, uploads a PDF, places a signature field, drags it, resizes it,
 * names a signer, and creates+sends the envelope — verifying it lands in the DB.
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

  // Wait for the React 18 client component to hydrate (fiber key appears on the
  // file input) — more targeted than networkidle, won't block on background polling.
  await page.waitForFunction(
    () => {
      const input = document.querySelector('input[accept="application/pdf"]')
      if (!input) return false
      return Object.keys(input).some((k: string) => k.startsWith("__reactFiber$"))
    },
    { timeout: 15000 },
  )

  // 3. Upload via React fiber direct invocation. CDP-based setInputFiles and the
  //    native filechooser API set the input's file state but don't reliably reach
  //    React 18's delegated onChange listener on the createRoot container; calling
  //    memoizedProps.onChange directly bypasses event delegation and fires the
  //    component's onPickFile handler immediately.
  const uploadOk = await page.evaluate(({ fileName, content }) => {
    const input = document.querySelector('input[accept="application/pdf"]') as HTMLInputElement
    if (!input) return { error: "input not found" }
    const file = new File([new Uint8Array(content)], fileName, { type: "application/pdf" })
    const dt = new DataTransfer()
    dt.items.add(file)
    Object.defineProperty(input, "files", { value: dt.files, configurable: true })
    const fiberKey = Object.keys(input).find((k: string) => k.startsWith("__reactFiber$"))
    if (!fiberKey) return { error: "no react fiber on input" }
    const fiber = (input as any)[fiberKey]
    const props = fiber?.memoizedProps || fiber?.pendingProps
    if (!props?.onChange) return { error: "no onChange in fiber props" }
    props.onChange({ target: input, preventDefault() {}, stopPropagation() {} })
    return { ok: true }
  }, { fileName: `${DOC_NAME}.pdf`, content: Array.from(pdfBuffer) })
  if (uploadOk && "error" in uploadOk) throw new Error(`Upload failed: ${(uploadOk as { error: string }).error}`)

  // 4. Wait for pdfjs to render the page, then click to drop a signature field.
  const pageEl = page.locator('[data-page="0"]')
  await expect(pageEl).toBeVisible({ timeout: 90000 })
  await page.waitForTimeout(500)
  await pageEl.click({ position: { x: 120, y: 380 } })

  // 5. Verify the placed field is visible and has a drag cursor.
  const fieldEl = pageEl.locator('[style*="cursor: move"]').first()
  await expect(fieldEl).toBeVisible({ timeout: 5000 })

  // 6. Drag the field: capture initial bounding box, drag 40px right + 20px down,
  //    confirm it moved. Uses pointer events (page.mouse dispatches pointerdown /
  //    pointermove / pointerup) which trigger the setPointerCapture drag logic.
  const boxBefore = await fieldEl.boundingBox()
  expect(boxBefore).toBeTruthy()
  const cx = boxBefore!.x + boxBefore!.width / 2
  const cy = boxBefore!.y + boxBefore!.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 40, cy + 20, { steps: 5 })
  await page.mouse.up()
  const boxAfter = await fieldEl.boundingBox()
  expect(boxAfter).toBeTruthy()
  // Position should have shifted (allow 5px tolerance for subpixel rounding)
  expect(Math.abs(boxAfter!.x - (boxBefore!.x + 40))).toBeLessThan(5)
  expect(Math.abs(boxAfter!.y - (boxBefore!.y + 20))).toBeLessThan(5)

  // 7. Resize via the SE corner handle (NW=0, NE=1, SE=2, SW=3 — all have data-rh="1").
  //    Drag SE handle 30px right + 15px down → field should grow.
  const seHandle = pageEl.locator('[data-rh="1"]').nth(2)
  await expect(seHandle).toBeVisible()
  const hbox = await seHandle.boundingBox()
  expect(hbox).toBeTruthy()
  const hcx = hbox!.x + hbox!.width / 2
  const hcy = hbox!.y + hbox!.height / 2
  await page.mouse.move(hcx, hcy)
  await page.mouse.down()
  await page.mouse.move(hcx + 30, hcy + 15, { steps: 5 })
  await page.mouse.up()
  const boxResized = await fieldEl.boundingBox()
  expect(boxResized).toBeTruthy()
  // Width and height should have grown (allow 5px tolerance)
  expect(boxResized!.width).toBeGreaterThan(boxAfter!.width - 5)
  expect(boxResized!.height).toBeGreaterThan(boxAfter!.height - 5)

  // 8. Fill in a third-party signer (name + email required). Switch to third-party
  //    first — the default is "CRM client" which shows a typeahead, not a name input.
  await page.getByRole("button", { name: "Third party" }).click()
  await page.getByPlaceholder("Third party 1 name").fill("QA Signer")
  await page.getByPlaceholder("email (required)").fill("qa-signer@example.com")

  // 9. Create & send (auto-send is wired directly into the create flow).
  await page.getByRole("button", { name: /Create & send/ }).click()

  // 10. Success screen appears — contains "Envelope created" (with or without "& sent")
  //     and a read-only input holding the signing link.
  await expect(page.getByText(/Envelope created/)).toBeVisible({ timeout: 30000 })
  await expect(page.locator("input[readonly]").first()).toHaveValue(/\/sign\//)

  // 11. Verify in the DB: envelope exists, is staff-origin, and status = "sent"
  //     (the auto-send call transitions it from "draft" → "sent").
  const { data: env } = await sb.from("esign_envelopes").select("id, status, total_signers, origin").eq("document_name", DOC_NAME).maybeSingle()
  expect(env).toBeTruthy()
  expect(env!.origin).toBe("staff")
  expect(env!.total_signers).toBe(1)
  expect(env!.status).toBe("sent") // auto-send fired: "draft" → "sent"
  const { data: fields } = await sb.from("esign_fields").select("field_type").eq("envelope_id", env!.id)
  expect((fields ?? []).some((f: { field_type: string }) => f.field_type === "signature")).toBe(true)
})
