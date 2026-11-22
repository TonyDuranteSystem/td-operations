/* eslint-disable no-console, no-restricted-syntax -- a SANDBOX QA script uses throw-away fixtures */
/**
 * Contact merge slice 3 (dev job 938af003) — SANDBOX proof of the login choice, through the real merge window.
 *   run (dev server on :3000, sandbox .env.local):  DOTENV_PATH=.env.local npx tsx scripts/crm-store/qa-cutover/t52-merge-logins-sandbox-check.ts
 * Makes throw-away people (is_test) and throw-away logins, drives the window with Playwright, then reads the database back:
 *   A  only the removed contact has a login: Merge stays OFF until a choice; "move it" -> the same login now belongs to the kept contact
 *   B  both have a login: "use the removed contact's login" -> it moves, the kept contact's old login is deleted
 *   C  both have a login, suggested choice: the kept login stays, the removed one is deleted
 *   D  only the removed contact has a login, "remove it" -> deleted, the kept contact has none
 */
import { config } from "dotenv"
import { chromium, type Page } from "playwright"
import { check, summary } from "./qa-http"
config({ path: process.env.DOTENV_PATH || ".env.local" })

const BASE = process.env.QA_BASE_URL || "http://localhost:3000"

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabaseAdmin as any
  const s = Date.now().toString(36)

  const mkContact = async (label: string) => {
    const { data, error } = await sb.from("contacts").insert({ full_name: `QA Slice3 ${label} ${s}`, email: `qa-s3-${label.toLowerCase().replace(/\s+/g, "-")}-${s}@example.com`, is_test: true }).select("id, full_name, email").single()
    if (error) throw new Error(error.message)
    return data as { id: string; full_name: string; email: string }
  }
  const mkLogin = async (c: { id: string; email: string }) => {
    const { data, error } = await sb.auth.admin.createUser({ email: c.email, password: `Qa-${s}-${Math.random().toString(36).slice(2)}!`, email_confirm: true, app_metadata: { role: "client", contact_id: c.id, portal_tier: "lead" } })
    if (error) throw new Error(error.message)
    return data.user.id as string
  }

  const A = { r: await mkContact("A Removed"), k: await mkContact("A Kept") }
  const B = { r: await mkContact("B Removed"), k: await mkContact("B Kept") }
  const C = { r: await mkContact("C Removed"), k: await mkContact("C Kept") }
  const D = { r: await mkContact("D Removed"), k: await mkContact("D Kept") }
  const aLogin = await mkLogin(A.r)
  const bLoginR = await mkLogin(B.r)
  const bLoginK = await mkLogin(B.k)
  const cLoginR = await mkLogin(C.r)
  const cLoginK = await mkLogin(C.k)
  const dLogin = await mkLogin(D.r)

  const contactOfLogin = async (id: string) => {
    const { data } = await sb.auth.admin.getUserById(id)
    return data?.user ? ((data.user.app_metadata as { contact_id?: string }).contact_id ?? null) : "DELETED"
  }

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
  await page.goto(`${BASE}/login`)
  await page.fill('input[type="email"]', process.env.QA_ADMIN_EMAIL ?? "")
  await page.fill('input[type="password"]', process.env.QA_ADMIN_PASSWORD ?? "")
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 }), page.click('button[type="submit"]')])

  const openWindow = async (p: Page, pair: { r: { id: string }; k: { full_name: string } }) => {
    await p.goto(`${BASE}/contacts/${pair.r.id}`, { waitUntil: "domcontentloaded" })
    await p.waitForTimeout(4000)   // hydration (never networkidle on this app)
    await p.screenshot({ path: "/tmp/t52-contact-page.png" })
    await p.getByRole("button", { name: /Delete \/ Merge|Merge this contact/ }).first().click({ timeout: 60000 })
    await p.getByPlaceholder(/Search the contact to keep/).fill(pair.k.full_name)
    await p.getByText(pair.k.full_name).first().click()
    await p.getByRole("dialog", { name: "Merge contacts" }).getByText("Logins").first().waitFor({ timeout: 60000 })
  }
  const dialog = (p: Page) => p.getByRole("dialog", { name: "Merge contacts" })
  const mergeBtn = (p: Page) => dialog(p).getByRole("button", { name: "Merge contacts" })
  const finish = async (p: Page) => {
    await dialog(p).getByLabel("Type MERGE to confirm").fill("MERGE")
    await mergeBtn(p).click()
    await p.waitForTimeout(6000)
  }

  // A
  await openWindow(page, A)
  check("A1 the login is listed with the removed contact", await dialog(page).getByText(A.r.email).count() > 0)
  check("A2 the person is asked to choose (Merge stays off)", await mergeBtn(page).isDisabled())
  check("A3 the move option is offered in plain words", await dialog(page).getByText(/move it to QA Slice3 A Kept/).count() > 0)
  await dialog(page).getByLabel(/move it to QA Slice3 A Kept/).check()
  await dialog(page).getByLabel("Type MERGE to confirm").fill("MERGE")
  check("A4 after the choice Merge is on", await mergeBtn(page).isEnabled())
  await page.screenshot({ path: "/tmp/t52-A-move.png", fullPage: false })
  await finish(page)
  check("A5 the login now belongs to the kept contact", (await contactOfLogin(aLogin)) === A.k.id, String(await contactOfLogin(aLogin)))
  const { data: aR } = await sb.from("contacts").select("merged_into").eq("id", A.r.id).single()
  check("A6 the removed contact is merged into the kept one", aR.merged_into === A.k.id)

  // B
  await openWindow(page, B)
  check("B1 both logins are listed", (await dialog(page).getByText(B.r.email).count()) > 0 && (await dialog(page).getByText(B.k.email).count()) > 0)
  check("B2 the kept login is suggested and Merge is not forced off by the login", await dialog(page).getByText("(suggested)").count() > 0)
  await dialog(page).getByLabel(new RegExp(`Use ${B.r.email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} instead`)).check()
  await page.screenshot({ path: "/tmp/t52-B-swap.png", fullPage: false })
  await finish(page)
  check("B3 the removed contact's login moved to the kept contact", (await contactOfLogin(bLoginR)) === B.k.id, String(await contactOfLogin(bLoginR)))
  check("B4 the kept contact's old login was deleted", (await contactOfLogin(bLoginK)) === "DELETED")

  // C (take the suggestion)
  await openWindow(page, C)
  await finish(page)
  check("C1 the kept login stays on the kept contact", (await contactOfLogin(cLoginK)) === C.k.id)
  check("C2 the removed contact's login was deleted", (await contactOfLogin(cLoginR)) === "DELETED")

  // D
  await openWindow(page, D)
  await dialog(page).getByLabel(/Remove the login/).check()
  check("D1 removing shows the lock-out warning in plain words", await dialog(page).getByText(/will have no portal login/).count() > 0)
  await finish(page)
  check("D2 the login was deleted", (await contactOfLogin(dLogin)) === "DELETED")

  await browser.close()
  // clean up the throw-away people and logins
  for (const id of [bLoginR, aLogin]) await sb.auth.admin.deleteUser(id).catch(() => null)
  for (const c of [A, B, C, D]) for (const x of [c.r, c.k]) await sb.from("contacts").delete().eq("id", x.id).then(() => null, () => null)
  summary()
}

main().catch((e) => { console.error(e); process.exit(1) })
