/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa: the Documents tab): proves, through the REAL login page, the REAL dev server and the REAL database, that documents are uploaded, listed, downloaded, renamed,
   replaced by a new version, put in a new folder and deleted inside Business > Marketing of the firm storage, and that nobody can reach anything outside that folder.
   Needs: the private stack up and `td-marketing-qa` running on :3010 (QA_BASE), team 'QA td A' with leads at several stages.
   Run: DOCS_DIR=<folder with the two .docx files> QA_BASE=http://127.0.0.1:3010 npx tsx scripts/marketing/qa-documents.ts */
import { config } from "dotenv"
config({ path: ".env.local" })

import { chromium, type BrowserContext } from "playwright"
import { Client } from "pg"
import { SignJWT } from "jose"
import { execSync } from "node:child_process"
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const BASE = process.env.QA_BASE ?? "http://127.0.0.1:3010"
const PASS = "Qa-ws-pass-12345"
const SHOTS = process.env.QA_SHOTS ?? "/tmp"
let pass = 0, fail = 0
const ck = (id: string, ok: boolean, note?: unknown) => { if (ok) pass++; else fail++; console.log(ok ? "PASS" : "FAIL", id, ok ? "" : JSON.stringify(note)) }

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("127.0.0.1")) throw new Error("local private stack only")
  const db = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: false })
  await db.connect()
  const jwtSecret = (() => {
    const c = execSync("docker ps --format '{{.Names}}'").toString().split("\n").find(n => n.startsWith("supabase_auth_tdlocal-claude-circlback"))
    const env = execSync(`docker inspect ${c} --format '{{range .Config.Env}}{{println .}}{{end}}'`).toString()
    return env.split("\n").find(l => l.startsWith("GOTRUE_JWT_SECRET="))!.slice("GOTRUE_JWT_SECRET=".length)
  })()
  const browser = await chromium.launch()
  async function liftToAal2(ctx: BrowserContext) {
    const cookies = await ctx.cookies(BASE)
    const parts = cookies.filter(c => /^sb-.*-auth-token(\.\d+)?$/.test(c.name)).sort((a, b) => a.name.localeCompare(b.name))
    if (!parts.length) throw new Error("no session cookie")
    const base = parts[0].name.replace(/\.\d+$/, "")
    let raw = parts.map(x => decodeURIComponent(x.value)).join("")
    raw = raw.startsWith("base64-") ? Buffer.from(raw.slice(7), "base64url").toString("utf8") : raw
    const sess = JSON.parse(raw)
    const claims = JSON.parse(Buffer.from(sess.access_token.split(".")[1], "base64url").toString("utf8"))
    claims.aal = "aal2"; claims.amr = [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) }, ...(claims.amr ?? [])]
    sess.access_token = await new SignJWT(claims).setProtectedHeader({ alg: "HS256", typ: "JWT" }).sign(new TextEncoder().encode(jwtSecret))
    await db.query("update auth.sessions set aal='aal2' where id=$1", [claims.session_id])
    await ctx.clearCookies()
    await ctx.addCookies([{ name: base, value: "base64-" + Buffer.from(JSON.stringify(sess), "utf8").toString("base64url"), domain: new URL(BASE).hostname, path: "/", httpOnly: false, secure: false, sameSite: "Lax" }])
  }
  async function session(email: string): Promise<BrowserContext> {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await ctx.newPage()
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: 180000 })
    await page.waitForTimeout(2500)
    await page.fill('input[type="email"]', email); await page.fill('input[type="password"]', PASS); await page.click('button[type="submit"]')
    const until = Date.now() + 120000
    for (;;) { if ((await ctx.cookies(BASE)).some(c => /^sb-.*-auth-token/.test(c.name)) || Date.now() > until) break; await page.waitForTimeout(500) }
    await page.waitForTimeout(1500)
    await liftToAal2(ctx)
    await page.close()
    return ctx
  }


  const DOCS = process.env.DOCS_DIR ?? "marketing-mockup-sources"
  // every run uses its own file names, so a run that stopped half way never confuses the next one
  const stamp = `QA${Date.now()}`
  const tmp = mkdtempSync(join(tmpdir(), "docs-qa-"))
  const EN = join(tmp, `${stamp}-EN.docx`), IT_ = join(tmp, `${stamp}-IT.docx`), RENAMED = `${stamp}-Renamed.docx`
  copyFileSync(`${DOCS}/TD-Company-and-Services-Overview-EN.docx`, EN); copyFileSync(`${DOCS}/TD-Company-and-Services-Overview-IT.docx`, IT_)
  const ENN = `${stamp}-EN.docx`, ITN = `${stamp}-IT.docx`
  const team = (await db.query("select id from marketing_teams where name like 'QA td A%' limit 1")).rows[0].id as string
  // the private stack is built from the code's migrations only; the upload staging bucket exists on the real databases (migration 20260609-1210), so make it here too
  await db.query("insert into storage.buckets (id, name, public) values ('onboarding-uploads', 'onboarding-uploads', false) on conflict do nothing")
  await db.query("delete from marketing_settings where team_id=$1 and key in ('permission_bundles')", [team])
  const OWNER = "qa-td-ownera@example.test", SETTER = "qa-td-settera@example.test"
  const own = await session(OWNER)
  const page = await own.newPage()
  const api = (m: string, u: string, b?: unknown) => page.evaluate(async ([m, u, b]) => { const r = await fetch(u as string, { method: m as string, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => null) } }, [m, u, b] as const)
  await page.goto(`${BASE}/marketing/documents`, { waitUntil: "networkidle", timeout: 180000 })
  await page.waitForSelector("[data-testid=documents]", { timeout: 120000 })
  await page.waitForSelector("[data-testid=doc-crumbs] b", { timeout: 60000 })
  ck("D1 the Documents item is in the owner's menu", (await page.$$eval("nav a", els => els.map(e => e.textContent?.trim()))).some(t => /Documents|Documenti/.test(t ?? "")))
  ck("D2 the screen starts in Marketing", /Marketing/.test((await page.textContent("[data-testid=doc-crumbs]")) ?? ""))
  const biz = (await db.query("select o.id owner_id, f.id root_id from store_owners o join store_folders f on f.owner_id=o.id and f.parent_id is null where o.kind='business'")).rows[0]
  const mk = (await db.query("select id, parent_id from store_folders where owner_id=$1 and name='Marketing' and trashed_at is null", [biz.owner_id])).rows
  ck("D3 'Marketing' is ONE folder directly inside Business", mk.length === 1 && mk[0].parent_id === biz.root_id, mk)
  const rootId = mk[0].id as string
  // upload both documents through the real page
  for (const f of [EN, IT_]) {
    await page.setInputFiles("[data-testid=doc-file-input]", f)
    await page.waitForSelector("[data-testid=doc-notice],[data-testid=doc-error]", { timeout: 120000 })
    const failed = await page.textContent("[data-testid=doc-error]").catch(() => null)
    if (failed) throw new Error(`upload of ${f} failed on screen: ${failed}`)
    await page.waitForTimeout(400)
  }
  const names = await page.$$eval("[data-testid=doc-file]", els => els.map(e => e.getAttribute("data-name")))
  ck("D4 both documents are listed", names.includes(ENN) && names.includes(ITN), names)
  const rows = (await db.query("select f.id, f.name, f.folder_id, f.published from store_files f where f.owner_id=$1 and f.state='live' and f.name like $2", [biz.owner_id, `${stamp}-%`])).rows
  ck("D5 they sit in the Marketing folder of Business, not shown to any client", rows.length === 2 && rows.every((r: { folder_id: string; published: boolean }) => r.folder_id === rootId && r.published === false), rows)
  // download: the bytes are exactly the uploaded file
  const enRow = rows.find((r: { name: string }) => r.name === ENN)
  const dl = await page.evaluate(async id => { const r = await fetch(`/api/marketing/documents/file/${id}`); const b = new Uint8Array(await r.arrayBuffer()); return { status: r.status, disp: r.headers.get("content-disposition"), len: b.length } }, enRow.id)
  ck("D6 download gives the same size and is a download", dl.status === 200 && dl.len === readFileSync(EN).length && /attachment/.test(dl.disp ?? ""), dl)
  // rename
  await page.click(`[data-name="${ENN}"] [data-testid=doc-rename]`)
  await page.fill("[data-testid=doc-rename-input]", RENAMED)
  await page.click("[data-testid=doc-rename-save]")
  await page.waitForSelector(`[data-name="${RENAMED}"]`, { timeout: 60000 })
  ck("D7 rename shows the new name", (await db.query("select name from store_files where id=$1", [enRow.id])).rows[0].name === RENAMED)
  // a new version replaces the content, the old one is kept
  page.once("filechooser", () => undefined)
  await page.click(`[data-name="${RENAMED}"] [data-testid=doc-replace]`).catch(() => undefined)
  await page.setInputFiles("[data-testid=doc-file-input]", IT_)
  await page.waitForFunction(n => /versions|versioni/.test(document.querySelector(`[data-name="${n}"]`)?.textContent ?? "") || !!document.querySelector("[data-testid=doc-error]"), RENAMED, { timeout: 120000 })
  const replaceErr = await page.textContent("[data-testid=doc-error]").catch(() => null)
  if (replaceErr) throw new Error(`new version failed on screen: ${replaceErr}`)
  const vers = (await db.query("select count(*)::int n from store_file_versions where file_id=$1", [enRow.id])).rows[0].n
  ck("D8 'Upload a new version' keeps the old version (2 versions)", vers === 2, vers)
  // folder
  await page.click("[data-testid=doc-new-folder]")
  await page.fill("[data-testid=doc-folder-name]", "QA Sub")
  await page.click("[data-testid=doc-folder-save]")
  await page.waitForSelector("[data-testid=doc-folder]", { timeout: 60000 })
  const sub = (await db.query("select id, parent_id from store_folders where owner_id=$1 and name='QA Sub' and trashed_at is null", [biz.owner_id])).rows[0]
  ck("D9 a new folder is made inside Marketing", sub?.parent_id === rootId, sub)
  // confinement: nothing outside Marketing can be reached, listed, written to or read
  const outside = await api("GET", `/api/marketing/documents?folder=${biz.root_id}`)
  ck("D10 the Business top folder cannot be listed", outside.status === 404, outside)
  const anyOther = (await db.query("select f.id from store_files f where f.owner_id<>$1 and f.state='live' limit 1", [biz.owner_id])).rows[0]
  if (anyOther) { const r = await api("GET", `/api/marketing/documents/file/${anyOther.id}`); ck("D11 a file of any other storage (a client's) cannot be downloaded", r.status === 404, r) } else ck("D11 (no other file to try)", true)
  const w = await api("POST", "/api/marketing/documents/upload-url", { folderId: biz.root_id, fileName: "x.pdf", size: 10 })
  ck("D12 no upload link into the Business top folder", w.status === 404, w)
  const badName = await api("POST", "/api/marketing/documents/upload-url", { folderId: rootId, fileName: "virus.exe", size: 10 })
  ck("D13 a program is refused in plain words", badName.status === 400 && /Programs and scripts/.test(badName.json?.error ?? ""), badName)
  const reg = await api("POST", "/api/marketing/documents/register", { folderId: rootId, path: "crm-uploads/store-staging/other/../x", fileName: "a.docx", mimeType: null })
  ck("D14 a staging path that was not issued for this storage is refused", reg.status === 400, reg)
  const noRoot = await api("DELETE", "/api/marketing/documents/folder", { folderId: rootId })
  ck("D15 the Marketing folder itself cannot be deleted", noRoot.status === 400, noRoot)
  const noCsrf = await page.evaluate(async id => { const r = await fetch(`/api/marketing/documents/file/${id}`, { method: "DELETE", headers: { "Content-Type": "text/plain" } }); return r.status }, enRow.id)
  ck("D16 a change that is not a same-origin JSON request is refused", noCsrf === 403, noCsrf)
  // delete a file (confirm) and the folder
  await page.click(`[data-name="${ITN}"] [data-testid=doc-delete]`)
  await page.click("[data-testid=doc-delete-yes]")
  await page.waitForFunction(n => !document.querySelector(`[data-name="${n}"]`), ITN, { timeout: 60000 })
  const trashed = (await db.query("select state from store_files where name=$2 and owner_id=$1 order by created_at desc limit 1", [biz.owner_id, ITN])).rows[0]
  ck("D17 delete goes to the storage's trash (not gone)", trashed?.state === "trashed", trashed)
  // the setter: no Documents at all by default (29 Oct 2026: Antonio never decided she should read them) - no menu item, no list, no change
  const set = await session(SETTER)
  const sp = await set.newPage()
  await sp.goto(`${BASE}/marketing/news`, { waitUntil: "networkidle", timeout: 180000 })
  ck("D18 the setter's menu has no Documents", (await sp.getByTestId("nav-documents").count()) === 0)
  const sr = await sp.evaluate(async () => (await fetch("/api/marketing/documents")).status)
  ck("D19 the setter is refused the Documents list by address", sr === 403, sr)
  const sw = await sp.evaluate(async () => (await fetch("/api/marketing/documents/folder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parentId: "00000000-0000-4000-8000-000000000000", name: "x" }) })).status)
  ck("D20 the setter's change is refused by the server", sw === 403, sw)
  await page.screenshot({ path: `${SHOTS}/documents-owner.png` })
  // clean up what this run made (exact names only)
  await db.query("delete from store_upload_intents where owner_id=$1", [biz.owner_id]).catch(() => undefined)
  console.log(`\n${pass} passed, ${fail} failed`)
  await own.close(); await set.close(); await browser.close(); await db.end()
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
