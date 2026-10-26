/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa, the Inbox): proves each role gets its own tour once, remembered, replayable, previewable by the owner and never recorded under View as; and that an
   invitation can be previewed and emailed once, through the REAL login page, dev server and database.
   Needs: the private stack up (with migrations 20261023-2000 and 20261024-2100 applied) and `td-marketing-qa` running on :3010.
   Run: npx tsx scripts/marketing/qa-inbox.ts */
import { config } from "dotenv"
config({ path: ".env.local" })
import { chromium, type BrowserContext } from "playwright"
import { Client } from "pg"
import { SignJWT } from "jose"
import { execSync } from "node:child_process"

const BASE = process.env.QA_BASE ?? "http://127.0.0.1:3010"
const PASS = "Qa-ws-pass-12345"
const SHOTS = process.env.QA_SHOTS ?? "/tmp"
const stamp = Date.now()
const em = (k: string) => `qa-in-${k.toLowerCase()}@example.test`
let pass = 0, fail = 0
const ck = (id: string, ok: boolean, note?: unknown) => { if (ok) pass++; else fail++; console.log(ok ? "PASS" : "FAIL", id, ok ? "" : JSON.stringify(note)) }

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("127.0.0.1")) throw new Error("local private stack only")
  const db = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: false })
  await db.connect()
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  const A = (supabaseAdmin as unknown as { auth: { admin: { listUsers: (a: object) => Promise<{ data: { users: Array<{ id: string; email?: string }> } }>; deleteUser: (id: string) => Promise<unknown> } } }).auth.admin
  const M = await import("@/lib/marketing/members")
  const S = await import("@/lib/marketing/settings")

  // clean an earlier run (local test database only)
  await db.query("set session_replication_role = replica")
  await db.query("delete from marketing_sales where lead_id in (select id from marketing_leads where leadgen_id like 'qin-%')")
  await db.query("delete from marketing_lead_events where lead_id in (select id from marketing_leads where leadgen_id like 'qin-%')")
  await db.query("delete from marketing_leads where leadgen_id like 'qin-%'")
  const oldTeams = (await db.query("select id from marketing_teams where name like 'QA in %'")).rows.map(x => x.id)
  if (oldTeams.length) {
    for (const t of ["marketing_team_members", "marketing_invites", "marketing_settings", "marketing_settings_history", "marketing_commission_terms"]) await db.query(`delete from ${t} where team_id = any($1)`, [oldTeams])
    await db.query("delete from marketing_teams where id = any($1)", [oldTeams])
  }
  await db.query("set session_replication_role = origin")
  for (const u of (await A.listUsers({ perPage: 1000 })).data.users.filter(u => (u.email ?? "").startsWith("qa-in-"))) await A.deleteUser(u.id)

  const teamA = (await S.createTeam({ name: `QA in A ${stamp}`, actor: "qa-in" })).data!
  await S.setTeamStatus(teamA.id, "active", "qa-in")
  const adminActor = { kind: "admin" as const, userId: null, label: "qa-in", permissions: [] as string[] }
  const tokenOf = (u: string) => new URL(u).searchParams.get("token") ?? ""
  const ids: Record<string, string> = {}
  const mk = async (key: string, role: "owner" | "member", bundle?: string) => {
    const inv = await M.createInvite({ teamId: teamA.id, email: em(key), memberRole: role, bundle: bundle ?? null, actor: adminActor })
    if (inv.ok === false) throw new Error(`invite ${key}: ${inv.error}`)
    const acc = await M.acceptInvite({ token: tokenOf(inv.data!.inviteUrl), password: PASS })
    if (acc.ok === false) throw new Error(`accept ${key}: ${acc.error}`)
    ids[key] = (await db.query("select id from auth.users where email=$1", [em(key)])).rows[0].id
    await db.query(`insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values (gen_random_uuid(), $1, 'qa', 'totp', 'verified', now(), now(), 'JBSWY3DPEHPK3PXP')`, [ids[key]])
  }
  await mk("ownerA", "owner"); await mk("setterA", "member", "setter"); await mk("aleA", "member", "content")
  for (const [key, role] of [["admin", "admin"], ["staff", "team"]] as const) {
    const r = await (supabaseAdmin as unknown as { auth: { admin: { createUser: (a: object) => Promise<{ data: { user: { id: string } | null }; error: { message: string } | null }> } } }).auth.admin.createUser({ email: em(key), password: PASS, email_confirm: true, app_metadata: { role } })
    if (r.error || !r.data.user) throw new Error(`seed ${key}: ${r.error?.message}`)
    ids[key] = r.data.user.id
  }








  const mkLead = async (n: string, name: string) =>
    (await db.query("insert into marketing_leads (team_id, leadgen_id, full_name, email, phone, status, ad_name, received_at, answers) values ($1,$2,$3,$4,'+393339990000','new','Ad Alpha', now() - interval '1 day', '[]'::jsonb) returning id", [teamA.id, `qin-${n}`, name, `qcl${n}@example.test`])).rows[0].id as string
  await mkLead("t1", "Marco Bianchi")
  for (const [k, v] of [["pipeline_stages", [{ key: "new", label: "New" }, { key: "contacted", label: "Contacted" }, { key: "qualified", label: "Qualified" }, { key: "not_in_target", label: "Not in target" }, { key: "sold", label: "Sold" }]], ["sale_kind_stages", { strategic_call: "sold" }]] as const) {
    const r = await S.setMarketingSetting({ key: k, value: v, teamId: teamA.id, actor: "qa-in" }); if (r.ok === false) throw new Error(`setting ${k}: ${r.error}`)
  }

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
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    const page = await ctx.newPage()
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: 180000 })
    await page.waitForTimeout(2500)
    await page.fill('input[type="email"]', email); await page.fill('input[type="password"]', PASS); await page.click('button[type="submit"]')
    const until = Date.now() + 120000
    for (;;) { if ((await ctx.cookies(BASE)).some(c => /^sb-.*-auth-token/.test(c.name)) || Date.now() > until) break; await page.waitForTimeout(500) }
    await page.waitForTimeout(1500)
    await liftToAal2(ctx)
    await ctx.addCookies([{ name: "tdm_lang", value: "en", domain: new URL(BASE).hostname, path: "/" }])
    await page.close()
    return ctx
  }










  type Pg = import("playwright").Page
  const open = async (ctx: BrowserContext, path = "/marketing") => { const p = await ctx.newPage(); await p.goto(BASE + path, { waitUntil: "networkidle", timeout: 180000 }); return p }
  const api = (p: Pg, method: string, path: string, payload?: object) => p.evaluate(async ([m, u, b]) => { const r = await fetch(u as string, { method: m as string, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) } }, [method, path, payload ?? null] as const)

  // the welcome tours are a different feature: mark them seen so they do not cover the page
  for (const k of ["ownerA", "setterA", "aleA"]) for (const t of ["owner", "setter", "seller", "analyst", "content", "generic"]) await db.query("insert into marketing_tour_seen (user_id, team_id, tour_key, status) values ($1,$2,$3,'skipped') on conflict do nothing", [ids[k], teamA.id, t])
  const sess = { admin: await session(em("admin")), owner: await session(em("ownerA")), setter: await session(em("setterA")) }
  const ROCCO = "rocco@tonydurante.us", MKT = "marketing@tonydurante.us"
  const T = (p: Pg, id: string) => p.getByTestId(id)
  const settingValue = async () => (await db.query("select value from marketing_settings where key='inbox_mailboxes' and team_id=$1", [teamA.id])).rows[0]?.value as Array<{ address: string; people: string[]; signature_name: string; signature_title: string; signature_phone: string }> | undefined

  // ---- A. Antonio adds the addresses in the CRM (the only way an address exists)
  const adm = await open(sess.admin, `/marketing-leads/settings?team=${teamA.id}`)
  await T(adm, "inbox-addresses").waitFor({ timeout: 90000 })
  ck("A1 the CRM Settings page has 'Inbox addresses' and says there is none yet", /No address yet/.test(await T(adm, "inbox-addresses").innerText()))
  const tryAddr = async (a: string) => { await adm.getByLabel("New inbox address").fill(a); await T(adm, "inbox-check").click(); await adm.waitForTimeout(1200); return (await adm.getByTestId("inbox-error").innerText().catch(() => "")) || (await T(adm, "inbox-checked").count() ? "OK" : "") }
  ck("A2 support@ is refused: it belongs to the CRM", /belongs to the CRM/.test(await tryAddr("support@tonydurante.us")))
  ck("A3 antonio@ is refused", /belongs to the CRM/.test(await tryAddr("antonio.durante@tonydurante.us")))
  ck("A4 an outside address is refused", /Only tonydurante\.us/.test(await tryAddr("bob@gmail.com")))
  ck("A5 an address the system cannot open is refused", /cannot open this mailbox/.test(await tryAddr("nobody@tonydurante.us")))
  ck("A6 a good address is connected", (await tryAddr(ROCCO)) === "OK")
  await T(adm, `inbox-new-person-${ids.ownerA}`).check()
  await T(adm, "sig-name").fill("Rocco Bianchi")
  await T(adm, "sig-title").fill("Sales, Tony Durante LLC")
  await T(adm, "inbox-checked").scrollIntoViewIfNeeded()
  await adm.screenshot({ path: `${SHOTS}/qa-inbox-settings-signature.png` })
  ck("A6b the add form shows the signature fields and the Full and Compact previews with his details", /Rocco Bianchi/.test(await T(adm, "sig-preview-full").innerText()) && /Sales, Tony Durante LLC/.test(await T(adm, "sig-preview-compact").innerText()) && /rocco@tonydurante\.us/.test(await T(adm, "sig-preview-compact").innerText()))
  await T(adm, "inbox-save").click()
  await T(adm, "inbox-done").waitFor({ timeout: 60000 })
  const v1 = await settingValue()
  ck("A7 saved: rocco@ visible to the owner only, with his signature", v1?.length === 1 && v1[0].address === ROCCO && v1[0].people.length === 1 && v1[0].people[0] === ids.ownerA && v1[0].signature_name === "Rocco Bianchi" && v1[0].signature_title === "Sales, Tony Durante LLC" && v1[0].signature_phone === "", v1)
  await adm.reload({ waitUntil: "networkidle" })
  ck("A8 the address shows as connected in the list", /connected/.test(await adm.getByTestId("inbox-address-row").first().innerText()))
  await adm.getByTestId(`sig-details-${ROCCO}`).locator("summary").click()
  ck("A8b the saved address has its signature editor with the saved details", (await T(adm, "sig-name").inputValue()) === "Rocco Bianchi")
  await T(adm, "sig-phone").fill("+39 333 1234567")
  await T(adm, `sig-save-${ROCCO}`).click()
  for (let i = 0; i < 20 && (await settingValue())?.[0]?.signature_phone !== "+39 333 1234567"; i++) await adm.waitForTimeout(300)
  ck("A8c editing the signature of a saved address saves it", (await settingValue())?.[0]?.signature_phone === "+39 333 1234567", await settingValue())
  const dup = await tryAddr(ROCCO)
  ck("A9 the same address twice is refused", /already added/.test(dup), dup)
  const own = await open(sess.owner, "/marketing/team")
  const noAdd = await api(own, "POST", "/api/marketing-admin/inbox-mailboxes", { teamId: teamA.id, action: "add", address: MKT, people: [], signature: {} })
  ck("A10 a team owner (not Antonio) cannot add an address: refused", noAdd.status === 403 && !(await settingValue())?.some(b => b.address === MKT), noAdd)

  // ---- B. Rocco's Inbox
  const oi = await open(sess.owner, "/marketing/inbox")
  let dialogAnswer = true
  oi.on("dialog", d => { void (dialogAnswer ? d.accept() : d.dismiss()) })
  await T(oi, "inbox").waitFor({ timeout: 90000 })
  await oi.getByTestId("inbox-row").first().waitFor({ timeout: 60000 })
  ck("B1 the owner sees ONE address button (rocco@) and its three emails", (await oi.locator('[data-testid^="inbox-box-"]').count()) === 1 && (await oi.getByTestId("inbox-row").count()) === 3)
  ck("B2 the two unread emails are marked, the address button shows 2", (await oi.locator('[data-testid="inbox-row"][data-unread="1"]').count()) === 2)
  await oi.waitForTimeout(1500)
  ck("B3 the menu's Inbox item shows the red number 2", (await oi.getByTestId("nav-inbox-badge").innerText().catch(() => "")) === "2")
  await oi.getByTestId("inbox-row").first().click()
  await T(oi, "inbox-thread").waitFor({ timeout: 60000 })
  ck("B4 opening an email shows it (subject, an html body in an isolated frame, the attachment)", /quick question/.test(await T(oi, "inbox-subject").innerText()) && (await oi.locator("iframe").count()) >= 1 && (await T(oi, "inbox-attachment").count()) === 1)
  await oi.waitForTimeout(1500)
  ck("B5 opening it marked it read (the row is no longer unread)", (await oi.locator('[data-testid="inbox-row"][data-unread="1"]').count()) === 1)
  const att = await api(oi, "GET", `/api/marketing/inbox/attachment?address=${ROCCO}&messageId=m1&attachmentId=a1&filename=offer-draft.pdf&mimeType=text/html`)
  ck("B6 an attachment is only ever a download of unknown type (an html attachment never runs on our address)", att.status === 200, att)
  const rawAtt = await oi.evaluate(async (a) => { const r = await fetch(a); return { ct: r.headers.get("content-type"), cd: r.headers.get("content-disposition"), no: r.headers.get("x-content-type-options") } }, `/api/marketing/inbox/attachment?address=${ROCCO}&messageId=m1&attachmentId=a1&filename=x.html&mimeType=text/html`)
  ck("B6b its headers: octet-stream, attachment, nosniff", rawAtt.ct === "application/octet-stream" && /attachment/.test(rawAtt.cd ?? "") && rawAtt.no === "nosniff", rawAtt)

  // reply
  await T(oi, "inbox-reply").click()
  await T(oi, "composer").waitFor({ timeout: 30000 })
  ck("B7 Reply opens the writing box from rocco@, to the sender, subject 'Re: …'", (await T(oi, "composer-from").innerText()) === ROCCO && (await T(oi, "composer-to").inputValue()) === "giulia@example.test" && /^Re: Free LLC call/.test(await T(oi, "composer-subject").inputValue()))
  ck("B7b the writing box has the Signature picker, Compact for an answer", (await T(oi, "composer-signature").inputValue()) === "text")
  await oi.locator(".ProseMirror").first().click()
  await oi.keyboard.type("Yes, two parts is fine. The registered agent is included.")
  await T(oi, "composer-send").click()
  await T(oi, "inbox-toast").filter({ hasText: "Sent from" }).waitFor({ timeout: 60000 })
  await T(oi, "inbox-folder-sent").click()
  await oi.getByTestId("inbox-row").first().waitFor({ timeout: 60000 })
  ck("B8 the reply is in Sent (same conversation)", /Free LLC call/.test(await oi.getByTestId("inbox-row").first().innerText()))
  await oi.getByTestId("inbox-row").first().click()
  await T(oi, "inbox-thread").waitFor({ timeout: 30000 })
  ck("B9 the conversation now has two messages, the second from rocco@", (await oi.getByTestId("inbox-message").count()) === 2 && /two parts is fine/.test(await oi.getByTestId("inbox-message").nth(1).innerText()))

  // actions in the inbox
  await T(oi, "inbox-folder-inbox").click()
  await oi.waitForTimeout(1500)
  await oi.getByTestId("inbox-row").first().waitFor({ timeout: 60000 })
  const rowsBefore = await oi.getByTestId("inbox-row").count()
  await oi.getByTestId("inbox-row").filter({ hasText: "Meta Ads" }).click()
  await T(oi, "inbox-thread").waitFor({ timeout: 30000 })
  await T(oi, "inbox-star").click()
  await oi.waitForTimeout(800)
  await T(oi, "inbox-folder-starred").click()
  await oi.waitForTimeout(1500)
  await oi.getByTestId("inbox-row").first().waitFor({ timeout: 60000 })
  ck("B10 Star puts it in Starred", (await oi.getByTestId("inbox-row").count()) === 1 && /Meta Ads|ad .Free LLC call/.test(await oi.getByTestId("inbox-row").first().innerText()), { n: await oi.getByTestId("inbox-row").count(), t: await oi.getByTestId("inbox-row").allInnerTexts() })
  await T(oi, "inbox-folder-inbox").click()
  await oi.getByTestId("inbox-row").first().waitFor({ timeout: 60000 })
  await oi.getByTestId("inbox-row").filter({ hasText: "Meta Ads" }).click()
  await T(oi, "inbox-thread").waitFor({ timeout: 30000 })
  await T(oi, "inbox-archive").click()
  await oi.waitForTimeout(800)
  ck("B11 Archive takes it out of the Inbox list", (await oi.getByTestId("inbox-row").count()) === rowsBefore - 1, { before: rowsBefore, now: await oi.getByTestId("inbox-row").allInnerTexts() })
  await oi.getByTestId("inbox-row").filter({ hasText: "Davide" }).click()
  await T(oi, "inbox-thread").waitFor({ timeout: 30000 })
  await T(oi, "inbox-unread").click()
  await oi.waitForTimeout(800)
  ck("B12 Mark unread makes it unread again", (await oi.locator('[data-testid="inbox-row"][data-unread="1"]').filter({ hasText: "Davide" }).count()) === 1)
  await T(oi, "inbox-delete").click()
  await oi.waitForTimeout(800)
  ck("B13 Delete removes it from the list (it goes to the bin, not erased)", (await oi.getByTestId("inbox-row").filter({ hasText: "Davide" }).count()) === 0)
  await T(oi, "inbox-search").fill("registered agent")
  await T(oi, "inbox-search-go").click()
  await oi.waitForTimeout(1200)
  ck("B14 search finds the email by its words, and Clear brings the list back", (await oi.getByTestId("inbox-row").count()) === 1 && (await (async () => { await T(oi, "inbox-search-clear").click(); await oi.waitForTimeout(1200); return (await oi.getByTestId("inbox-row").count()) >= 1 })()))

  // new email with an attachment, then a draft
  await T(oi, "inbox-new").click()
  await T(oi, "composer").waitFor({ timeout: 30000 })
  await T(oi, "composer-to").fill("newlead@example.test")
  await T(oi, "composer-show-cc").click()
  await T(oi, "composer-cc").fill("boss@example.test")
  await T(oi, "composer-subject").fill("Your free call")
  await oi.locator(".ProseMirror").first().click()
  await oi.keyboard.type("Hello, here is the information.")
  await T(oi, "composer-attach").setInputFiles({ name: "info.txt", mimeType: "text/plain", buffer: Buffer.from("hello attachment") })
  await T(oi, "composer-files").waitFor({ timeout: 60000 })
  ck("B15 the attachment is uploaded and listed", /info\.txt/.test(await T(oi, "composer-files").innerText()))
  await T(oi, "composer-send").click()
  await T(oi, "inbox-toast").filter({ hasText: "Sent from" }).waitFor({ timeout: 60000 })
  await T(oi, "inbox-folder-sent").click()
  await oi.getByTestId("inbox-row").first().waitFor({ timeout: 60000 })
  await oi.getByTestId("inbox-row").filter({ hasText: "Your free call" }).click()
  await T(oi, "inbox-thread").waitFor({ timeout: 30000 })
  ck("B16 the new email is in Sent with its attachment, to the right person", (await T(oi, "inbox-attachment").count()) === 1 && /info\.txt/.test(await T(oi, "inbox-attachment").innerText()) && /newlead@example\.test/.test(await oi.getByTestId("inbox-message").first().innerText()))
  await T(oi, "inbox-new").click()
  await T(oi, "composer").waitFor({ timeout: 30000 })
  await T(oi, "composer-to").fill("draftperson@example.test")
  await T(oi, "composer-subject").fill("Draft idea")
  await oi.locator(".ProseMirror").first().click()
  await oi.keyboard.type("Half written")
  await T(oi, "composer-save-draft").click()
  await T(oi, "composer-note").waitFor({ timeout: 30000 })
  await T(oi, "inbox-folder-drafts").click()
  await oi.getByTestId("inbox-row").first().waitFor({ timeout: 60000 })
  ck("B17 Save draft puts it in Drafts", /Draft idea/.test(await oi.getByTestId("inbox-row").first().innerText()))
  await oi.getByTestId("inbox-row").first().click()
  await T(oi, "inbox-edit-draft").click()
  await T(oi, "composer").waitFor({ timeout: 30000 })
  ck("B18 Edit draft re-opens it filled in", (await T(oi, "composer-to").inputValue()) === "draftperson@example.test" && (await T(oi, "composer-subject").inputValue()) === "Draft idea", { to: await T(oi, "composer-to").inputValue(), sub: await T(oi, "composer-subject").inputValue() })
  await T(oi, "composer-send").click()
  await T(oi, "inbox-toast").filter({ hasText: "Sent from" }).waitFor({ timeout: 60000 })
  await oi.getByTestId("inbox-folder-drafts").click()
  await oi.waitForTimeout(1500)
  ck("B19 sending the draft removes it from Drafts", (await oi.getByTestId("inbox-row").count()) === 0)
  // a bad recipient and an empty message are refused with the reason
  await T(oi, "inbox-new").click()
  await T(oi, "composer").waitFor({ timeout: 30000 })
  await T(oi, "composer-to").fill("not an address")
  await T(oi, "composer-subject").fill("x")
  await oi.locator(".ProseMirror").first().click()
  await oi.keyboard.type("hello")
  await T(oi, "composer-send").click()
  await T(oi, "composer-error").waitFor({ timeout: 30000 })
  ck("B20 a bad recipient is refused with the reason, nothing is sent", /does not look like an email/.test(await T(oi, "composer-error").innerText()))
  await T(oi, "composer-discard").click()
  // the signature picked next to Send: Full on a new email, none when chosen
  await T(oi, "inbox-new").click()
  await T(oi, "composer").waitFor({ timeout: 30000 })
  await T(oi, "composer").screenshot({ path: `${SHOTS}/qa-inbox-composer-signature.png` })
  ck("B15b a new email starts with Full signature", (await T(oi, "composer-signature").inputValue()) === "gala")
  await T(oi, "composer-to").fill("sigtest@example.test")
  await T(oi, "composer-subject").fill("Signature test full")
  await oi.locator(".ProseMirror").first().click()
  await oi.keyboard.type("Body one")
  await T(oi, "composer-send").click()
  await T(oi, "inbox-toast").filter({ hasText: "Sent from" }).waitFor({ timeout: 60000 })
  await T(oi, "inbox-new").click()
  await T(oi, "composer").waitFor({ timeout: 30000 })
  await T(oi, "composer-signature").selectOption("none")
  await T(oi, "composer-to").fill("sigtest2@example.test")
  await T(oi, "composer-subject").fill("Signature test none")
  await oi.locator(".ProseMirror").first().click()
  await oi.keyboard.type("Body two")
  await T(oi, "composer-send").click()
  await T(oi, "inbox-toast").filter({ hasText: "Sent from" }).waitFor({ timeout: 60000 })
  await T(oi, "inbox-folder-sent").click()
  await oi.waitForTimeout(1500)
  await oi.getByTestId("inbox-row").filter({ hasText: "Signature test full" }).click()
  await T(oi, "inbox-thread").waitFor({ timeout: 30000 })
  const fullTxt = await oi.getByTestId("inbox-message").last().innerText()
  await oi.getByTestId("inbox-row").filter({ hasText: "Signature test none" }).click()
  await oi.getByTestId("inbox-subject").filter({ hasText: "Signature test none" }).waitFor({ timeout: 30000 })
  const noneTxt = await oi.getByTestId("inbox-message").last().innerText()
  ck("B15c the Full email carries Rocco's signature (name, title, phone, company address, his address)", /Rocco Bianchi/.test(fullTxt) && /Sales, Tony Durante LLC/.test(fullTxt) && /\+39 333 1234567/.test(fullTxt) && /Ulmerton/.test(fullTxt) && /rocco@tonydurante\.us/.test(fullTxt), fullTxt)
  ck("B15d 'No signature' sends the words only", /Body two/.test(noneTxt) && !/Ulmerton|Rocco Bianchi/.test(noneTxt), noneTxt)

  // ---- B+. a saved draft comes back as saved; abandoned uploads are thrown away; a half-written email is not lost silently
  const staged = async () => Number((await db.query("select count(*)::int c from storage.objects where bucket_id='marketing-chat' and name like $1", [`${teamA.id}/inbox/%`])).rows[0].c)
  await T(oi, "inbox-folder-inbox").click()
  await oi.waitForTimeout(1500)
  await oi.getByTestId("inbox-row").filter({ hasText: "quick question" }).click()
  await T(oi, "inbox-thread").waitFor({ timeout: 30000 })
  await T(oi, "inbox-reply").click()
  await T(oi, "composer").waitFor({ timeout: 30000 })
  await T(oi, "composer-show-cc").click()
  await T(oi, "composer-bcc").fill("boss@example.test")
  await oi.locator(".ProseMirror").first().click()
  await oi.keyboard.type("Draft answer one")
  await T(oi, "composer-save-draft").click()
  await T(oi, "composer-note").waitFor({ timeout: 30000 })
  await T(oi, "inbox-folder-drafts").click()
  await oi.waitForTimeout(1500)
  await oi.getByTestId("inbox-row").filter({ hasText: "quick question" }).first().click()
  await T(oi, "inbox-edit-draft").click()
  await T(oi, "composer").waitFor({ timeout: 30000 })
  const edTxt = await oi.locator(".ProseMirror").first().innerText()
  ck("B22 Edit draft brings back the Bcc, the To, and the text once (signature once)", (await T(oi, "composer-bcc").inputValue()) === "boss@example.test" && (await T(oi, "composer-to").inputValue()).includes("giulia@example.test") && /Draft answer one/.test(edTxt) && (edTxt.split(/\nOn .* wrote:/)[0].match(/Ulmerton/g) ?? []).length === 1, { edTxt, bcc: await T(oi, "composer-bcc").inputValue() })
  await T(oi, "composer-send").click()
  await T(oi, "inbox-toast").filter({ hasText: "Sent from" }).waitFor({ timeout: 60000 })
  await oi.waitForTimeout(2000)
  ck("B22b right after sending the edited draft the reader no longer offers that draft again (no second send possible)", (await T(oi, "inbox-edit-draft").count()) === 0 && !/Draft answer one[\s\S]*Draft answer one/.test(await oi.locator("body").innerText()))
  await T(oi, "inbox-folder-sent").click()
  await oi.waitForTimeout(1500)
  await oi.getByTestId("inbox-row").filter({ hasText: "quick question" }).first().click()
  await T(oi, "inbox-thread").waitFor({ timeout: 30000 })
  const lastMsg = await oi.getByTestId("inbox-message").last().innerText()
  ck("B23 the draft went out in the SAME conversation, signature once, not copied twice", /Draft answer one/.test(lastMsg) && (lastMsg.split(/\nOn .* wrote:/)[0].match(/Ulmerton/g) ?? []).length === 1, lastMsg)
  await T(oi, "inbox-folder-drafts").click()
  await oi.waitForTimeout(1500)
  ck("B24 and it is gone from Drafts", (await oi.getByTestId("inbox-row").filter({ hasText: "quick question" }).count()) === 0)
  // uploads
  const before = await staged()
  await T(oi, "inbox-new").click()
  await T(oi, "composer").waitFor({ timeout: 30000 })
  await T(oi, "composer-attach").setInputFiles({ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("aaa") })
  await T(oi, "composer-files").waitFor({ timeout: 60000 })
  ck("B25 an attached file is staged in storage", (await staged()) === before + 1)
  await oi.getByLabel("Remove").first().click()
  for (let i = 0; i < 20 && (await staged()) !== before; i++) await oi.waitForTimeout(300)
  ck("B26 removing it from the email deletes the stored copy", (await staged()) === before)
  await T(oi, "composer-attach").setInputFiles({ name: "b.txt", mimeType: "text/plain", buffer: Buffer.from("bbb") })
  await T(oi, "composer-files").waitFor({ timeout: 60000 })
  await T(oi, "composer-discard").click()
  for (let i = 0; i < 20 && (await staged()) !== before; i++) await oi.waitForTimeout(300)
  ck("B27 closing the email without sending deletes the stored copy", (await staged()) === before, { now: await staged(), before })
  // a second "New email" press starts a fresh, empty box
  await T(oi, "inbox-new").click()
  await T(oi, "composer").waitFor({ timeout: 30000 })
  await T(oi, "composer-subject").fill("typed before")
  await T(oi, "inbox-new").click()
  await oi.waitForTimeout(800)
  ck("B30 pressing New email again (OK) gives a fresh empty box", (await T(oi, "composer-subject").inputValue()) === "", await T(oi, "composer-subject").inputValue())
  await T(oi, "composer-discard").click()
  await oi.waitForTimeout(1500)
  // a half-written email is not thrown away silently
  await T(oi, "inbox-new").click()
  await T(oi, "composer").waitFor({ timeout: 30000 })
  await T(oi, "composer-to").fill("someone@example.test")
  dialogAnswer = false
  await T(oi, "inbox-folder-sent").click()
  await oi.waitForTimeout(1500)
  ck("B28 leaving a half-written email asks first; 'Cancel' keeps it", (await T(oi, "composer").count()) === 1 && (await T(oi, "composer-to").inputValue().catch(() => "gone")) === "someone@example.test", { composers: await T(oi, "composer").count(), to: await T(oi, "composer-to").inputValue().catch(() => "gone") })
  dialogAnswer = true
  await T(oi, "inbox-folder-sent").click()
  await oi.waitForTimeout(1500)
  ck("B29 …and 'OK' lets it go", (await T(oi, "composer").count()) === 0)

  // a copied link opens that thread
  await oi.goto(`${BASE}/marketing/inbox?address=${ROCCO}&thread=t1`, { waitUntil: "domcontentloaded" })
  await T(oi, "inbox-thread").waitFor({ timeout: 60000 })
  ck("B21 a copied link (address + thread in the address bar) opens that email", /quick question/.test(await T(oi, "inbox-subject").innerText()))
  await oi.screenshot({ path: `${SHOTS}/qa-inbox-thread.png` })

  // ---- C. The wall
  const si = await open(sess.setter, "/marketing/inbox")
  ck("C1 a team member Antonio did not tick sees 'No mailbox is set up for you yet'", (await T(si, "inbox-none").count()) === 1 && (await si.locator('[data-testid^="inbox-box-"]').count()) === 0)
  const probe = async (p: Pg, path: string) => (await api(p, "GET", path)).status
  ck("C2 the same person, asking the server for rocco@ by hand, gets 'not found' (list, thread, attachment)", (await probe(si, `/api/marketing/inbox/threads?address=${ROCCO}&folder=inbox`)) === 404 && (await probe(si, `/api/marketing/inbox/threads/t1?address=${ROCCO}`)) === 404 && (await probe(si, `/api/marketing/inbox/attachment?address=${ROCCO}&messageId=m1&attachmentId=a1`)) === 404)
  const sendTry = await api(si, "POST", "/api/marketing/inbox/send", { address: ROCCO, to: "x@example.test", subject: "s", message: "m" })
  ck("C3 …and cannot send from it", sendTry.status === 404, sendTry)
  for (const a of ["support@tonydurante.us", "antonio.durante@tonydurante.us"]) {
    const o = await probe(oi, `/api/marketing/inbox/threads?address=${a}&folder=inbox`)
    const ad = await probe(adm, `/api/marketing/inbox/threads?address=${a}&folder=inbox`)
    ck(`C4 the CRM mailbox ${a} is not found for the owner NOR for Antonio himself`, o === 404 && (ad === 404 || ad === 403), { o, ad })
  }
  const anon = await (await browser.newContext()).request.get(`${BASE}/api/marketing/inbox/mailboxes`)
  ck("C5 signed out: refused", anon.status() === 401 || anon.status() === 403, anon.status())
  const noPerm = await db.query("select 1")
  void noPerm
  // Antonio ticks the setter -> he sees it; unticks -> gone
  await adm.reload({ waitUntil: "networkidle" })
  await T(adm, `inbox-person-${ROCCO}-${ids.setterA}`).click()
  await adm.waitForTimeout(2500)
  const si2 = await open(sess.setter, "/marketing/inbox")
  await si2.getByTestId("inbox-row").first().waitFor({ timeout: 60000 })
  ck("C6 ticked in Settings, the setter now sees rocco@ and its emails", (await si2.locator('[data-testid^="inbox-box-"]').count()) === 1)
  await adm.reload({ waitUntil: "networkidle" })
  await T(adm, `inbox-person-${ROCCO}-${ids.setterA}`).click()
  await adm.waitForTimeout(2500)
  ck("C7 unticked, he is shut out again at once", (await probe(si2, `/api/marketing/inbox/threads?address=${ROCCO}&folder=inbox`)) === 404)
  // the person the address belongs to (login address = the mailbox address) always sees it: use the setting directly on a throwaway address
  const v2 = await settingValue()
  ck("C8 the setting still lists only rocco@ (nothing else was added by the refused attempts)", v2?.length === 1, v2)

  // ---- D. Italian and Antonio
  await sess.owner.addCookies([{ name: "tdm_lang", value: "it", domain: new URL(BASE).hostname, path: "/" }])
  const oit = await open(sess.owner, "/marketing/inbox")
  await T(oit, "inbox-search").waitFor({ timeout: 60000 })
  ck("D1 in Italian the Inbox speaks Italian", (await T(oit, "inbox-search").getAttribute("placeholder")) === "Cerca in questa casella" && /Posta|Inbox/.test(await oit.locator("h1").innerText()) && /Nuova email/.test(await T(oit, "inbox-new").innerText()))
  await sess.owner.addCookies([{ name: "tdm_lang", value: "en", domain: new URL(BASE).hostname, path: "/" }])
  // Antonio is a team member? no: he opens the workspace only through View as; he sees every address there
  await api(adm, "POST", "/api/marketing-admin/view-as", { teamId: teamA.id, as: "setter" })
  const av = await open(sess.admin, "/marketing/inbox")
  await av.getByTestId("inbox-row").first().waitFor({ timeout: 60000 })
  ck("D2 Antonio looking in (View as) sees every address of the team", (await av.locator('[data-testid^="inbox-box-"]').count()) === 1)
  await api(av, "DELETE", "/api/marketing-admin/view-as")

  await browser.close(); await db.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(2) })
