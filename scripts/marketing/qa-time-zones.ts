/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa, Addendum K: time zones and calendars): proves, through the REAL login page, dev server and database, with a STAND-IN Google (a small
   server in this script that the app talks to through GOOGLE_CALENDAR_API_BASE and a throw-away service-account key), that
   - a lead shows its zone with its source, asks when the phone number has several zones, and the choice is kept in the history;
   - the setter's page never carries the owner's time (HTML checked), the seller's page has the banner and the three clocks;
   - typed times mean the typer's own zone; the Calendar reads the viewer's zone;
   - with the calendar switches on: free slots (Busy time of two calendars, share check), the booking writes an event into the seller's work calendar, a move moves it, a cancel removes it,
     a Google failure leaves the call saved and says so; the setter's page never made a Google request about the owner;
   - the owner sees his own Google events, adds and moves one (guests asked first, no delete), and sees the seller's personal time only as Busy;
   - the Team page section saves zones, links and switches; the booking box offers the saved links.
   Needs: the private stack up, and the dev server on :3050 started with GOOGLE_SA_KEY (the throw-away key) and GOOGLE_CALENDAR_API_BASE=http://127.0.0.1:4455.
   Run: QA_BASE=http://127.0.0.1:3050 npx tsx scripts/marketing/qa-time-zones.ts */
import { config } from "dotenv"
config({ path: ".env.local" })
import { chromium, type BrowserContext, type Page } from "playwright"
import { Client } from "pg"
import { SignJWT } from "jose"
import { execSync } from "node:child_process"
import http from "node:http"
import { mkdirSync } from "node:fs"

const BASE = process.env.QA_BASE ?? "http://127.0.0.1:3050"
const FAKE_PORT = 4455
const PASS = "Qa-ws-pass-12345"
const SHOTS = process.env.QA_SHOTS ?? "/tmp/qa-tz"
const stamp = Date.now()
const SELLER = "qa-tz-rocco@tonydurante.us"
const ADMIN = "qa-tz-antonio@tonydurante.us"
const PERS = "qa-tz-personal@example.test"
const em = (k: string) => (k === "sellerA" ? SELLER : k === "adminA" ? ADMIN : `qa-tz-${k.toLowerCase()}@example.test`)
let pass = 0, fail = 0
const ck = (id: string, ok: boolean, note?: unknown) => { if (ok) pass++; else fail++; console.log(ok ? "PASS" : "FAIL", id, ok ? "" : JSON.stringify(note)) }

// ───────────────────────────── the stand-in Google ─────────────────────────────
interface Ev { id: string; summary: string; start: { dateTime: string }; end: { dateTime: string }; attendees?: Array<{ email: string }>; extendedProperties?: { private?: Record<string, string> } }
const world = {
  lists: {} as Record<string, Array<{ id: string; accessRole: string; primary?: boolean }>>,
  busy: {} as Record<string, Record<string, Array<{ start: string; end: string }>>>,
  events: {} as Record<string, Ev[]>,
  log: [] as string[],
  failNext: new Set<string>(),
  n: 1,
}
function startFakeGoogle(): Promise<http.Server> {
  const srv = http.createServer((req, res) => {
    let raw = ""
    req.on("data", c => { raw += c })
    req.on("end", () => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${FAKE_PORT}`)
      const send = (code: number, body: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)) }
      if (url.pathname === "/token") {
        const jwt = new URLSearchParams(raw).get("assertion") ?? ""
        const sub = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8") || "{}").sub as string
        return send(200, { access_token: `tok:${sub}`, expires_in: 3600 })
      }
      const sub = (req.headers.authorization ?? "").replace("Bearer tok:", "")
      const path = decodeURIComponent(url.pathname)
      const key = `${req.method} ${path.replace(/\/events\/[^/]+$/, "/events/:id").replace(/\/calendars\/[^/]+\//, "/calendars/:cal/")}`
      world.log.push(`${req.method} ${path} as ${sub}`)
      if (world.failNext.has(key)) { world.failNext.delete(key); return send(500, { error: { message: "stand-in failure" } }) }
      const body = raw ? JSON.parse(raw) : {}
      if (path === "/users/me/calendarList") return send(200, { items: world.lists[sub] ?? [] })
      if (path === "/freeBusy") return send(200, { calendars: Object.fromEntries((body.items as Array<{ id: string }>).map(i => [i.id, world.busy[sub]?.[i.id] ? { busy: world.busy[sub][i.id] } : { busy: [], errors: [{ reason: "notFound" }] }])) })
      const m = /^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(path)
      if (m) {
        const cal = m[1], id = m[2], k = `${sub}|${cal}`
        const list = (world.events[k] ??= [])
        if (req.method === "GET" && !id) return send(200, { items: list })
        if (req.method === "GET" && id) { const e = list.find(x => x.id === id); return e ? send(200, e) : send(404, { error: { message: "Not Found" } }) }
        if (req.method === "POST") { const e: Ev = { id: `qaevent${world.n++}`, summary: body.summary, start: body.start, end: body.end, extendedProperties: body.extendedProperties }; list.push(e); return send(200, e) }
        if (req.method === "PATCH" && id) { const e = list.find(x => x.id === id); if (!e) return send(404, { error: { message: "Not Found" } }); Object.assign(e, body); return send(200, e) }
        if (req.method === "DELETE" && id) { world.events[k] = list.filter(x => x.id !== id); res.writeHead(204); return res.end() }
      }
      return send(404, { error: { message: `no stand-in route for ${key}` } })
    })
  })
  return new Promise(r => srv.listen(FAKE_PORT, "127.0.0.1", () => r(srv)))
}

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("127.0.0.1")) throw new Error("local private stack only")
  mkdirSync(SHOTS, { recursive: true })
  const fake = await startFakeGoogle()
  const db = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: false })
  await db.connect()
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  const A = (supabaseAdmin as unknown as { auth: { admin: { listUsers: (a: object) => Promise<{ data: { users: Array<{ id: string; email?: string }> } }>; deleteUser: (id: string) => Promise<unknown>; createUser: (a: object) => Promise<{ data: { user: { id: string } | null }; error: { message: string } | null }> } } }).auth.admin
  const M = await import("@/lib/marketing/members")
  const S = await import("@/lib/marketing/settings")
  const Z = await import("@/lib/marketing/zones")

  // clean an earlier run (local test database only)
  await db.query("set session_replication_role = replica")
  for (const t of ["marketing_sales"]) await db.query(`delete from ${t} where lead_id in (select id from marketing_leads where leadgen_id like 'qtz-%')`)
  await db.query("delete from marketing_lead_events where lead_id in (select id from marketing_leads where leadgen_id like 'qtz-%')")
  await db.query("delete from marketing_leads where leadgen_id like 'qtz-%'")
  const oldTeams = (await db.query("select id from marketing_teams where name like 'QA tz %'")).rows.map(x => x.id)
  if (oldTeams.length) {
    for (const t of ["marketing_team_members", "marketing_invites", "marketing_settings", "marketing_settings_history", "marketing_commission_terms"]) await db.query(`delete from ${t} where team_id = any($1)`, [oldTeams])
    await db.query("delete from marketing_teams where id = any($1)", [oldTeams])
  }
  await db.query("set session_replication_role = origin")
  for (const u of (await A.listUsers({ perPage: 1000 })).data.users.filter(u => (u.email ?? "").startsWith("qa-tz-"))) await A.deleteUser(u.id)

  const team = (await S.createTeam({ name: `QA tz ${stamp}`, actor: "qa-tz" })).data!
  await S.setTeamStatus(team.id, "active", "qa-tz")
  const adminActor = { kind: "admin" as const, userId: null, label: "qa-tz", permissions: [] as string[] }
  const tokenOf = (u: string) => new URL(u).searchParams.get("token") ?? ""
  const ids: Record<string, string> = {}
  const mfa = (uid: string) => db.query(`insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values (gen_random_uuid(), $1, 'qa', 'totp', 'verified', now(), now(), 'x')`, [uid])
  const mk = async (key: string, role: "owner" | "member", bundle?: string) => {
    const inv = await M.createInvite({ teamId: team.id, email: em(key), memberRole: role, bundle: bundle ?? null, actor: adminActor })
    if (inv.ok === false) throw new Error(`invite ${key}: ${inv.error}`)
    const acc = await M.acceptInvite({ token: tokenOf(inv.data!.inviteUrl), password: PASS })
    if (acc.ok === false) throw new Error(`accept ${key}: ${acc.error}`)
    ids[key] = (await db.query("select id from auth.users where email=$1", [em(key)])).rows[0].id
    await mfa(ids[key])
  }
  await mk("sellerA", "member", "seller"); await mk("setterA", "member", "setter")
  {
    const r = await A.createUser({ email: ADMIN, password: PASS, email_confirm: true, app_metadata: { role: "admin" }, user_metadata: { name: "Antonio Durante" } })
    if (r.error || !r.data.user) throw new Error(`seed admin: ${r.error?.message}`)
    ids.adminA = r.data.user.id
    await mfa(ids.adminA)
    const add = await M.addAdminAsOwner({ teamId: team.id, admin: { id: ids.adminA, email: ADMIN } })
    if (add.ok === false) throw new Error(`admin member: ${add.error}`)
  }
  for (const uid of Object.values(ids)) for (const k of ["setter", "seller", "content", "analyst", "owner"]) await db.query("insert into marketing_tour_seen (user_id, team_id, tour_key, status) values ($1,$2,$3,'done') on conflict do nothing", [uid, team.id, k])
  const put = async (key: string, value: unknown) => { const r = await S.setMarketingSetting({ key, value, teamId: team.id, actor: "qa-tz" }); if (r.ok === false) throw new Error(`setting ${key}: ${r.error}`) }
  await put("owner_clock", { zone: "America/New_York", label: "Antonio", email: ADMIN })
  await put("member_time_zones", { [ids.sellerA]: "Atlantic/Canary", [ids.setterA]: "Europe/Rome" })
  await put("member_call_hours", { [ids.sellerA]: {} })
  await put("member_calendly_links", { [ids.sellerA]: [{ id: "solo-1", name: "Solo call", url: "https://calendly.com/qa/solo-call" }, { id: "with-1", name: "With Antonio", url: "https://calendly.com/qa/with-antonio" }] })
  await put("member_personal_calendars", { [ids.sellerA]: [PERS] })
  for (const [k, v] of [["pipeline_stages", [{ key: "new", label: "New" }, { key: "contacted", label: "Contacted" }, { key: "qualified", label: "Qualified" }, { key: "booked", label: "Booked" }, { key: "not_in_target", label: "Not in target" }, { key: "paid_call", label: "Paid call" }, { key: "booking_link", label: "Booking link sent" }]], ["sale_kind_stages", { strategic_call: "paid_call" }]] as const) await put(k, v)

  // the days used: the next working day after tomorrow, read in the seller's zone
  const CAN = "Atlantic/Canary", NY = "America/New_York"
  let D = ""
  for (let i = 2; i < 12 && !D; i++) { const k = Z.zoneParts(Date.now() + i * 86400000, CAN)!.key; const wd = new Date(`${k}T12:00:00Z`).getUTCDay(); if (wd >= 1 && wd <= 5) D = k }
  const at = (key: string, hhmm: string, zone: string) => Z.localToIso(`${key}T${hhmm}`, zone)!
  const blk = (key: string, a: string, b: string, zone: string) => ({ start: at(key, a, zone), end: at(key, b, zone) })
  const evt = (key: string, a: string, b: string, zone: string) => { const x = blk(key, a, b, zone); return { start: { dateTime: x.start }, end: { dateTime: x.end } } }
  const resetWorld = () => {
    world.lists = { [SELLER]: [{ id: SELLER, accessRole: "owner", primary: true }, { id: PERS, accessRole: "freeBusyReader" }] }
    world.busy = { [SELLER]: { primary: [blk(D, "14:00", "14:30", CAN)], [PERS]: [blk(D, "10:00", "12:00", CAN)] }, [ADMIN]: { primary: [blk(D, "10:00", "11:00", NY)] } }
    world.events = {
      [`${SELLER}|primary`]: [
        { id: "weeklyevt", summary: "Weekly call", ...evt(D, "14:00", "14:30", CAN), attendees: [{ email: SELLER }, { email: ADMIN }] },
        { id: "secretevt", summary: "Private appointment", ...evt(D, "17:00", "18:00", CAN) },
      ],
      [`${ADMIN}|primary`]: [
        { id: "bankevent", summary: "Bank meeting", ...evt(D, "10:00", "11:00", NY), attendees: [{ email: "x@bank.test" }] },
        { id: "focus0001", summary: "Focus time", ...evt(D, "15:00", "16:00", NY) },
        // the same weekly call, as it sits on the OWNER's calendar (Google keeps a copy on every guest's calendar)
        { id: "weeklyown1", summary: "Weekly call", ...evt(D, "09:00", "09:30", NY), attendees: [{ email: ADMIN }, { email: SELLER }] },
      ],
    }
    world.log = []; world.failNext.clear()
  }
  resetWorld()

  const mkLead = async (n: string, name: string, phone: string, o: { status?: string; claimed?: string | null } = {}) =>
    (await db.query("insert into marketing_leads (team_id, leadgen_id, full_name, email, phone, status, ad_name, received_at, claimed_by, claimed_by_label, answers) values ($1,$2,$3,$4,$5,$6,'Ad Alpha', now() - interval '30 hours', $7, $8, '[]'::jsonb) returning id",
      [team.id, `qtz-${n}-${stamp}`, name, `${n}@example.test`, phone, o.status ?? "qualified", o.claimed ?? null, o.claimed ? SELLER : null])).rows[0].id as string
  const Marco = await mkLead("marco", "Marco Rossi", "+39 02 1234 5678")
  const Dana = await mkLead("dana", "Dana Smith", "+1 212 555 0100")
  const Gina = await mkLead("gina", "Gina Bianchi", "+39 06 7654 3210")
  const Elena = await mkLead("elena", "Elena Verdi", "+39 051 000 0003", { status: "paid_call", claimed: ids.sellerA })

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
  async function session(email: string, lang = "en"): Promise<BrowserContext> {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const page = await ctx.newPage()
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: 180000 })
    await page.waitForTimeout(2500)
    await page.fill('input[type="email"]', email); await page.fill('input[type="password"]', PASS); await page.click('button[type="submit"]')
    const until = Date.now() + 120000
    for (;;) { if ((await ctx.cookies(BASE)).some(c => /^sb-.*-auth-token/.test(c.name)) || Date.now() > until) break; await page.waitForTimeout(500) }
    await page.waitForTimeout(1500)
    await liftToAal2(ctx)
    await ctx.addCookies([{ name: "tdm_lang", value: lang, domain: new URL(BASE).hostname, path: "/" }])
    await page.close()
    return ctx
  }
  const text = (p: Page) => p.locator("body").innerText().then(t => t.replace(/\s+/g, " "))
  const open = async (ctx: BrowserContext, path: string) => { const p = await ctx.newPage(); await p.goto(BASE + path, { waitUntil: "networkidle", timeout: 240000 }); return p }
  const events = async (lead: string, kind: string) => (await db.query("select data, actor from marketing_lead_events where lead_id=$1 and kind=$2 order by created_at desc, id desc", [lead, kind])).rows
  const shot = (p: Page, name: string) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })
  const setting = async (key: string) => (await db.query("select value from marketing_settings where key=$1 and team_id=$2", [key, team.id])).rows[0]?.value
  const sellerEvents = () => world.events[`${SELLER}|primary`] ?? []
  const asAdmin = () => world.log.filter(l => l.endsWith(`as ${ADMIN}`)).length

  const setter = await session(em("setterA")), seller = await session(SELLER), admin = await session(ADMIN)

  // ═════ A. B1/B2 with the switches OFF
  let p = await open(setter, `/marketing/window/${Marco}`)
  let t = await text(p), html = await p.content()
  ck("A1 setter: Marco's zone is Rome, from the phone number", /Time zone: Rome/.test(t) && /from the phone number \(\+39\)/.test(t), t.slice(0, 400))
  ck("A2 setter: three clocks (client, seller, herself) and none for the owner", JSON.stringify(await p.locator("[data-clock]").evaluateAll(e => e.map(x => x.getAttribute("data-clock")))) === JSON.stringify(["client", "seller", "you"]))
  ck("A3 setter: nothing of the owner's time anywhere in the page (text and HTML)", !/New York|Antonio|America\/New_York/.test(t + html))
  ck("A4 setter: the page says its times are Rome time", /Times on this page are Rome time/.test(t))
  await p.getByTestId("handover-book").click()
  t = await text(p)
  ck("A5 setter: the typed-time box names her zone and shows only the client's and the seller's times", /your time: Rome/.test(t))
  await p.getByTestId("appointment-when").fill(`${D}T16:00`)
  const tl = await p.getByTestId("times-line").first().innerText()
  ck("A6 setter: 'their times' = Marco 16:00 Rome, Rocco 15:00 Canary Islands, no owner", /Marco 16:00 Rome/.test(tl) && /Rocco 15:00 Canary Islands/.test(tl) && !/Antonio|New York/.test(tl), tl)
  await shot(p, "A-setter-lead"); await p.close()

  p = await open(setter, `/marketing/window/${Dana}`)
  t = await text(p)
  ck("A7 setter: Dana's +1 number is NOT guessed: the page asks which zone", /The time zone is not known yet/.test(t) && /Which one is Dana in/.test(t), t.slice(0, 300))
  const optGroup = await p.locator("optgroup[label=\"This number's zones\"] option").allInnerTexts()
  ck("A8 setter: the number's own zones come first (New York among them)", optGroup.includes("New York"), optGroup)
  await p.getByTestId("zone-select").selectOption("America/Chicago")
  await p.waitForFunction(() => /Chicago/.test(document.body.innerText) && /set by/.test(document.body.innerText), null, { timeout: 60000 })
  const zs = await events(Dana, "zone_set")
  ck("A9 the zone she picked is a history entry", zs.length === 1 && zs[0].data.zone === "America/Chicago" && zs[0].actor === em("setterA"), zs)
  ck("A10 the clock appears for Dana now (client clock has a time)", /Dana, the client/i.test(await text(p)) && !/--:--/.test(await p.locator("[data-clock=client]").innerText()))
  await p.close()

  p = await open(seller, `/marketing/window/${Marco}`)
  t = await text(p)
  ck("A11 seller: the lead window no longer carries a banner of its own (the persistent one is on every screen)", (await p.getByTestId("seller-banner").count()) === 0, t.slice(0, 200))
  ck("A11b seller: the clocks are slim (one short strip, not big cards)", ((await p.getByTestId("lead-clocks").first().boundingBox())?.height ?? 999) < 90, await p.getByTestId("lead-clocks").first().boundingBox())
  ck("A12 seller: three clocks, the third is the owner's", JSON.stringify(await p.locator("[data-clock]").evaluateAll(e => e.map(x => x.getAttribute("data-clock")))) === JSON.stringify(["client", "seller", "owner"]))
  await shot(p, "A-seller-lead")
  await p.getByTestId("handover-book").click()
  await p.getByTestId("appointment-when").fill(`${D}T16:00`)
  const tl2 = await p.getByTestId("times-line").first().innerText()
  ck("A13 seller: 'their times' include Antonio in New York", /Antonio 11:00 New York/.test(tl2) || /Antonio \d\d:00 New York/.test(tl2), tl2)
  await p.getByTestId("book-confirm").click()
  await p.waitForFunction(() => /Call booked for/.test(document.body.innerText), null, { timeout: 60000 })
  const ap = await events(Marco, "appointment")
  ck("A14 a time typed by the seller is read in HIS zone (16:00 Canary = 16:00Z in winter / 15:00Z in summer)", ap.length === 1 && ap[0].data.at === at(D, "16:00", CAN), { got: ap[0]?.data?.at, want: at(D, "16:00", CAN) })
  ck("A15 with the switches off nothing was written to Google (no request at all)", world.log.length === 0, world.log)
  await p.close()

  const cal = await open(seller, "/marketing/calendar")
  t = await text(cal)
  ck("A16 the seller's Calendar says its times are Canary Islands time", /Times are Canary Islands time/.test(t), t.slice(0, 300))
  await cal.close()
  const calS = await open(setter, "/marketing/calendar")
  ck("A17 the setter's Calendar is read in Rome time and makes no Google request", /Times are Rome time/.test(await text(calS)) && world.log.length === 0)
  await calS.close()

  // ═════ B. B5 with the switches ON
  await put("calendar_busy_enabled", true); await put("calendar_write_through_enabled", true)
  resetWorld()
  p = await open(setter, `/marketing/window/${Gina}`)
  await p.getByTestId("handover-book").click()
  await p.getByTestId("slot").first().waitFor({ timeout: 60000 })
  const adminBefore = asAdmin()
  // the day pills: pick D
  const dayBtns = p.getByTestId("slot-day")
  const labelD = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${D}T12:00:00Z`)).replace(",", "")
  await dayBtns.filter({ hasText: labelD }).first().click()
  const slotTexts = await p.getByTestId("slot").allInnerTexts()
  // Canary 09:00 = Rome 10:00 is free; Rome 11:00-13:15 (Canary 10:00-12:15 incl. the gap) and Rome 14:45-15:45 (the weekly call) are not
  ck("B1 the setter is offered Rome 10:00 and not the hours the seller is busy (personal calendar and weekly call)", slotTexts.includes("10:00") && !slotTexts.some(s => ["11:00", "11:30", "12:00", "12:30", "13:00", "15:00"].includes(s)), slotTexts)
  ck("B2 the slot buttons carry times only (no reason why a time is missing)", !/Busy|Private|Weekly|Dentist/.test(await text(p)))
  await shot(p, "B-setter-slots")
  await p.getByTestId("slot").filter({ hasText: "18:00" }).first().click() // Rome 18:00 = Canary 17:00 (the 17:00 Rome hour is Marco's booked call)
  const tl3 = await p.getByTestId("times-line").first().innerText()
  ck("B3 the chosen slot is shown in the client's, the seller's time (no owner)", /Rocco 17:00 Canary Islands/.test(tl3) && !/Antonio|New York/.test(tl3), tl3)
  await p.getByTestId("book-confirm-slot").click()
  await p.waitForFunction(() => /Call booked for/.test(document.body.innerText), null, { timeout: 60000 })
  const apG = await events(Gina, "appointment")
  ck("B4 the call is saved at the chosen slot", apG.length === 1 && apG[0].data.at === at(D, "17:00", CAN), apG[0]?.data)
  const mine = sellerEvents().filter(e => e.extendedProperties?.private?.td_marketing_call === Gina)
  ck("B5 an event was written into the SELLER's work calendar: first name and 'Call' only, with the private mark", mine.length === 1 && mine[0].summary === "Gina · Call" && mine[0].start.dateTime === at(D, "17:00", CAN), mine)
  const synced = await events(Gina, "calendar_synced")
  ck("B6 the history remembers the event", synced.length === 1 && synced[0].data.event_id === mine[0]?.id && synced[0].data.act_as === SELLER, synced)
  ck("B7 the setter's pages never made a Google request about the owner", asAdmin() === adminBefore, world.log.filter(l => l.endsWith(`as ${ADMIN}`)))
  t = await text(p); html = await p.content()
  ck("B8 the setter's page, after booking, still carries nothing of the owner", !/New York|Antonio|America\/New_York/.test(t + html))
  await p.close()

  // the seller moves the call
  p = await open(seller, `/marketing/window/${Gina}`)
  await p.getByTestId("handover-book").click()
  await p.getByTestId("slot").first().waitFor({ timeout: 60000 })
  await p.getByTestId("slot-day").filter({ hasText: labelD }).first().click()
  const sellerSlots = await p.getByTestId("slot").allInnerTexts()
  ck("B9 moving: the call's own hour is free again for the lead being moved (18:00 offered), and Marco's booked hour is not (17:00)", sellerSlots.includes("18:00") && !sellerSlots.includes("17:00"), sellerSlots)
  await p.getByTestId("slot").filter({ hasText: "16:00" }).first().click()
  await p.getByTestId("book-confirm-slot").click()
  await p.waitForFunction(() => /Call booked for/.test(document.body.innerText) && /16:00/.test(document.body.innerText), null, { timeout: 60000 })
  await p.waitForTimeout(1500)
  const moved = sellerEvents().filter(e => e.extendedProperties?.private?.td_marketing_call === Gina)
  ck("B10 the move changed the SAME event (still one), now at the new hour", moved.length === 1 && moved[0].id === mine[0].id && moved[0].start.dateTime === at(D, "15:00", CAN), moved)
  // cancel
  await p.getByRole("button", { name: "Cancel the call" }).click()
  await p.waitForFunction(() => /No call booked yet/.test(document.body.innerText), null, { timeout: 60000 })
  await p.waitForTimeout(1000)
  ck("B11 cancelling removed that event and no other (the seller's other events are still there)", sellerEvents().every(e => !e.extendedProperties?.private?.td_marketing_call) && sellerEvents().length === 2, sellerEvents().map(e => e.summary))
  const syncedAfter = await events(Gina, "calendar_synced")
  ck("B12 the history says it was taken off", syncedAfter[0]?.data?.removed === true, syncedAfter[0])
  // Google refuses: the call is still saved and the screen says so
  world.failNext.add("POST /calendars/:cal/events")
  await p.getByTestId("handover-book").click()
  await p.getByTestId("slot").first().waitFor({ timeout: 60000 })
  await p.getByTestId("slot-day").filter({ hasText: labelD }).first().click()
  await p.getByTestId("slot").filter({ hasText: "16:00" }).first().click()
  await p.getByTestId("book-confirm-slot").click()
  await p.getByTestId("calendar-warning").waitFor({ timeout: 60000 })
  ck("B13 Google refused: the screen says the call is saved but the calendar was not updated", /saved, but .* calendar was not updated/.test(await p.getByTestId("calendar-warning").innerText()))
  ck("B14 …and the call IS saved, with the failure in the history", (await events(Gina, "appointment")).length === 4 && (await events(Gina, "calendar_sync_failed")).length === 1)
  await p.close()

  // the share check: too wide hides the slots, never shows the seller as free
  world.lists[SELLER][1].accessRole = "writer"
  p = await open(setter, `/marketing/window/${Marco}`)
  await p.getByTestId("handover-book").click()
  await p.getByTestId("slots-hidden").waitFor({ timeout: 60000 })
  ck("B15 share too wide: no slot at all, a plain message, typing a time is still possible", (await p.getByTestId("slot").count()) === 0 && /Free times are hidden/.test(await text(p)) && (await p.getByTestId("appointment-when").count()) === 1)
  await shot(p, "B-setter-hidden"); await p.close()
  world.lists[SELLER][1].accessRole = "freeBusyReader"

  // ═════ C. the owner's own calendar and the seller's Busy time
  const wd = async (pg: Page) => { for (let i = 0; i < 6 && (await pg.locator(`[data-day="${D}"]`).count()) === 0; i++) await pg.getByTestId("cal-next").click(); await pg.locator(`[data-day="${D}"]`).first().waitFor({ timeout: 60000 }) }
  const oc = await open(admin, "/marketing/calendar")
  await oc.getByTestId("cal-view-week").click(); await wd(oc)
  await oc.waitForTimeout(1500)
  const gTexts = await oc.locator(`[data-day="${D}"] [data-testid=cal-google]`).evaluateAll(e => e.map(x => ({ tone: x.getAttribute("data-tone"), text: (x as HTMLElement).innerText.replace(/\s+/g, " ") })))
  ck("C1 the owner sees his own events in full", gTexts.some(g => g.tone === "mine" && /Bank meeting/.test(g.text)) && gTexts.some(g => g.tone === "mine" && /Focus time/.test(g.text)), gTexts)
  ck("C2 the seller's personal time is only 'Busy' for the owner, and his private appointment is not named", gTexts.some(g => g.tone === "busy" && /Busy/.test(g.text)) && !JSON.stringify(gTexts).includes("Private appointment"), gTexts)
  ck("C3 the weekly call (the owner is a guest) is drawn once", gTexts.filter(g => /Weekly call/.test(g.text)).length === 1, gTexts)
  if (process.env.QA_DEBUG) console.log("DEBUG google log:", JSON.stringify(world.log.slice(-14)), "| owner events:", JSON.stringify((world.events[`${ADMIN}|primary`] ?? []).map(e => [e.id, e.start.dateTime])))
  const busyAll = await oc.locator("[data-testid=cal-google][data-tone=busy]").count()
  await shot(oc, "C-owner-calendar")
  ck("C4 there is no delete anywhere on the Calendar", (await oc.locator("[data-testid*=delete], button:has-text('Delete')").count()) === 0)
  // add
  await oc.getByTestId("cal-add-event").click()
  await oc.getByTestId("add-title").fill("QA added event"); await oc.getByTestId("add-when").fill(`${D}T12:00`)
  await oc.getByTestId("add-save").click()
  await oc.getByTestId("add-event-dialog").waitFor({ state: "detached", timeout: 60000 })
  const added = (world.events[`${ADMIN}|primary`] ?? []).find(e => e.summary === "QA added event")
  ck("C5 'Add event' wrote it into the owner's own calendar at the typed hour in HIS zone (New York)", !!added && added.start.dateTime === at(D, "12:00", NY), added)
  // move without guests
  await oc.locator(`[data-day="${D}"] [data-testid=cal-google]:has-text("Focus time") [data-testid=cal-google-move]`).first().click()
  await oc.getByTestId("move-event-when").fill(`${D}T16:30`)
  await oc.getByTestId("move-event-save").click()
  await oc.getByTestId("move-event-dialog").waitFor({ state: "detached", timeout: 60000 })
  const focus = (world.events[`${ADMIN}|primary`] ?? []).find(e => e.id === "focus0001")
  ck("C6 moving an event without guests moves it and keeps its length", focus?.start.dateTime === at(D, "16:30", NY) && focus?.end.dateTime === at(D, "17:30", NY), focus)
  // move with a guest: asked first
  await oc.waitForTimeout(1500)
  const patchesBefore = world.log.filter(l => l.startsWith("PATCH") && l.includes("bankevent")).length
  await oc.locator(`[data-day="${D}"] [data-testid=cal-google]:has-text("Bank meeting") [data-testid=cal-google-move]`).first().click()
  await oc.getByTestId("move-event-when").fill(`${D}T09:00`)
  await oc.getByTestId("move-event-save").click()
  await oc.getByTestId("guest-warning").waitFor({ timeout: 60000 })
  ck("C7 an event with a guest asks first, naming the guest, and nothing moved yet", /x@bank\.test/.test(await oc.getByTestId("guest-warning").innerText()) && world.log.filter(l => l.startsWith("PATCH") && l.includes("bankevent")).length === patchesBefore)
  await shot(oc, "C-owner-guest-ask")
  await oc.getByTestId("move-event-save").click()
  await oc.getByTestId("move-event-dialog").waitFor({ state: "detached", timeout: 60000 })
  const bank = (world.events[`${ADMIN}|primary`] ?? []).find(e => e.id === "bankevent")
  ck("C8 after 'Yes, move it' the event moved", bank?.start.dateTime === at(D, "09:00", NY), bank)
  await oc.close()
  const sc = await open(seller, "/marketing/calendar")
  await sc.getByTestId("cal-view-week").click(); await wd(sc); await sc.waitForTimeout(1500)
  const sTexts = await sc.locator(`[data-day="${D}"] [data-testid=cal-google]`).evaluateAll(e => e.map(x => ({ tone: x.getAttribute("data-tone"), text: (x as HTMLElement).innerText.replace(/\s+/g, " ") })))
  ck("C9 the seller sees his work calendar in full (including the private one), his personal time as Busy, and the owner's time only as Busy", sTexts.some(g => g.tone === "td" && /Private appointment/.test(g.text)) && sTexts.some(g => g.tone === "busy") && !JSON.stringify(sTexts).includes("Bank meeting") && !JSON.stringify(sTexts).includes("QA added event"), sTexts)
  ck("C10 the seller has no 'Add event' (it is the owner's own calendar)", (await sc.getByTestId("cal-add-event").count()) === 0)
  await sc.close()
  const sc2 = await open(setter, "/marketing/calendar")
  await sc2.getByTestId("cal-view-week").click(); await wd(sc2); await sc2.waitForTimeout(1500)
  const sc2Items = await sc2.locator(`[data-day="${D}"] [data-testid=cal-google]`).evaluateAll(e => e.map(x => ({ tone: x.getAttribute("data-tone"), text: (x as HTMLElement).innerText.replace(/\s+/g, " ") })))
  ck("C11 the setter's Calendar shows the SELLER's busy time only as grey Busy blocks: no title, nothing of the owner", sc2Items.length > 0 && sc2Items.every(g => g.tone === "busy" && /^Busy/.test(g.text) && !/Antonio|Weekly|Private|Bank|Focus/.test(g.text)), sc2Items)
  ck("C11b …and the setter's Calendar is built without the owner's zone", !/New York|America\/New_York/.test(await sc2.content()))
  await sc2.close()
  // share too wide: the owner sees the warning and no personal Busy
  world.lists[SELLER][1].accessRole = "writer"
  const ow = await open(admin, "/marketing/calendar")
  await ow.getByTestId("cal-view-week").click(); await wd(ow); await ow.waitForTimeout(1500)
  ck("C12 share too wide: the owner is warned and the personal Busy time is hidden", (await ow.getByTestId("cal-share-warning").count()) === 1 && (await ow.locator("[data-testid=cal-google][data-tone=busy]").count()) < busyAll, { before: busyAll, after: await ow.locator("[data-testid=cal-google][data-tone=busy]").count() })
  await ow.close()
  world.lists[SELLER][1].accessRole = "freeBusyReader"

  // ═════ D. the Team page
  const tp = await open(admin, "/marketing/team")
  ck("D1 the Team page has the time-zones section", (await tp.getByTestId("team-times").count()) === 1 && (await tp.getByTestId("member-times").count()) === 2)
  ck("D2 the share of the personal calendar is read from Google: 'free/busy only'", (await tp.getByTestId("share-state").first().getAttribute("data-state")) === "free_busy")
  await shot(tp, "D-team")
  const card = tp.getByTestId("member-times").filter({ hasText: SELLER })
  await card.getByTestId("time-zone-select").selectOption("Europe/London")
  await tp.waitForFunction(() => /Saved\./.test(document.body.innerText), null, { timeout: 60000 })
  ck("D3 changing a person's zone is saved as a setting", ((await setting("member_time_zones")) as Record<string, string>)[ids.sellerA] === "Europe/London")
  await card.getByTestId("time-zone-select").selectOption("Atlantic/Canary")
  await tp.waitForFunction(() => /Saved\./.test(document.body.innerText) , null, { timeout: 60000 })
  await tp.getByTestId("link-name").fill("QA link"); await tp.getByTestId("link-url").fill("http://not-secure.test/x")
  await tp.getByTestId("link-add").click()
  await tp.waitForFunction(() => /https:\/\//.test(document.body.innerText), null, { timeout: 15000 })
  ck("D4 a link that does not start with https:// is refused", ((await setting("member_calendly_links")) as Record<string, unknown[]>)[ids.sellerA].length === 2)
  await tp.getByTestId("link-url").fill("https://calendly.com/qa/extra")
  await tp.getByTestId("link-add").click()
  await tp.waitForFunction(() => /QA link/.test(document.body.innerText), null, { timeout: 60000 })
  ck("D5 a good link is added to the list", ((await setting("member_calendly_links")) as Record<string, Array<{ name: string }>>)[ids.sellerA].some(l => l.name === "QA link"))
  world.lists[SELLER][1].accessRole = "writer"
  await tp.getByTestId("share-check-again").first().click()
  await tp.waitForFunction(() => document.querySelector("[data-testid=share-state]")?.getAttribute("data-state") === "wide", null, { timeout: 60000 })
  ck("D6 'Check again' reads Google again: shared too wide is shown, with what it means", /hidden until this is fixed/.test(await text(tp)))
  world.lists[SELLER][1].accessRole = "freeBusyReader"
  await tp.close()
  ck("D7 the stand-in Google was asked only about calendars of the company (acted as the seller or the owner, never a personal address)", world.log.every(l => /as (qa-tz-rocco|qa-tz-antonio)@tonydurante\.us$/.test(l)), world.log.filter(l => !/as (qa-tz-rocco|qa-tz-antonio)@tonydurante\.us$/.test(l)))
  ck("D8 …and a personal calendar was only asked free/busy, its events were never listed", !world.log.some(l => l.includes(PERS) && l.includes("/events")))

  // ═════ E. the booking box and Italian
  p = await open(seller, `/marketing/window/${Elena}`)
  ck("E1 the booking box offers the saved links as choices", (await p.getByTestId("booking-link-choice").count()) >= 2, await text(p))
  await p.getByTestId("booking-link-choice").filter({ hasText: "With Antonio" }).first().click()
  ck("E2 choosing a link puts it in the message", /calendly\.com\/qa\/with-antonio/.test(await p.getByTestId("booking-message").inputValue()) && /with-antonio/.test(await p.getByTestId("booking-link-url").innerText()))
  await shot(p, "E-booking"); await p.close()
  const it = await session(em("setterA"), "it")
  p = await open(it, `/marketing/window/${Marco}`)
  t = await text(p)
  ck("E3 in Italian: the clocks and the zone row are translated", /il cliente/i.test(t) && /Fuso orario:/.test(t) && /dal numero di telefono/.test(t), t.slice(0, 300))
  await p.close()

  // ═════ F. the bug hunt of 30 Oct 2026: a setter that somebody marked as "takes calls" must still get nothing of the owner's or the seller's time
  await put("member_call_hours", { [ids.sellerA]: {}, [ids.setterA]: {} }); await put("calendar_busy_enabled", true)
  world.lists[SELLER][1].accessRole = "freeBusyReader"
  const adminBeforeF = asAdmin()
  const sf = await open(setter, "/marketing/calendar")
  t = await text(sf); html = await sf.content()
  await sf.getByTestId("cal-view-week").click(); await wd(sf); await sf.waitForTimeout(1500)
  ck("F1 the setter marked as 'takes calls': still only the seller's Busy blocks, no share warning, nothing of the owner", (await sf.locator(`[data-day="${D}"] [data-testid=cal-google]`).count()) > 0 && (await sf.locator("[data-testid=cal-google]:not([data-tone=busy])").count()) === 0 && (await sf.getByTestId("cal-share-warning").count()) === 0 && !/New York|Antonio|America\/New_York/.test(t + html), t.slice(0, 200))
  await sf.close()
  p = await open(setter, `/marketing/window/${Marco}`)
  t = await text(p); html = await p.content()
  ck("F2 …and her lead page has no banner, no owner clock, nothing of the owner", (await p.getByTestId("seller-banner").count()) === 0 && (await p.locator("[data-clock=owner]").count()) === 0 && !/New York|Antonio|America\/New_York/.test(t + html))
  ck("F3 …and no Google request was made about the owner, nor acting as the setter", asAdmin() === adminBeforeF && !world.log.some(l => l.endsWith(`as ${em("setterA")}`)), world.log.slice(-6))
  await p.close()
  const tf = await open(admin, "/marketing/team")
  ck("F4 the Team page does not offer the setter 'Takes calls'", (await tf.getByTestId("setter-no-calls").count()) === 1 && (await tf.getByTestId("takes-calls").count()) === 1, await tf.getByTestId("takes-calls").count())
  await tf.close()
  // the list screens read times in the viewer's zone and still open
  for (const [who, path, label] of [[seller, "/marketing/leads", "seller Leads"], [seller, "/marketing/board", "seller Board"], [seller, "/marketing/today", "seller Today"], [setter, "/marketing/call-list", "setter Call list"], [setter, "/marketing/board", "setter Board"]] as const) {
    const pg = await open(who, path); const tx = await text(pg)
    ck(`F5 ${label} opens (times read in the viewer's zone)`, tx.length > 40 && !/Application error|Something went wrong|This page could not/i.test(tx), tx.slice(0, 160))
    await pg.close()
  }
  await put("member_call_hours", { [ids.sellerA]: {} })

  // ═════ G. "View as" is a real person's page (31 Oct 2026, Antonio: "the screenshot is from Rocco's page and I don't see them"). No member holds a role, so the team owner and seller previews used to
  // fall back to Antonio himself: Rome time and no Google. Now they are the seller's page (his zone, his Google time); the setter and analyst previews still show no Google.
  resetWorld(); world.lists[SELLER][1].accessRole = "freeBusyReader"; await put("calendar_busy_enabled", true)
  const dayItems = async (pg: Page) => { await pg.getByTestId("cal-view-week").click(); await wd(pg); await pg.waitForTimeout(1500); return pg.locator(`[data-day="${D}"] [data-testid=cal-google]`).evaluateAll(e => e.map(x => `${x.getAttribute("data-tone")}|${(x as HTMLElement).innerText.replace(/\s+/g, " ")}`).sort()) }
  const viewAsCtx = async (key: string) => { const c = await session(ADMIN); await c.addCookies([{ name: "td_marketing_view_as", value: `${team.id}:${key}`, domain: new URL(BASE).hostname, path: "/" }]); return c }
  const realSeller = await open(seller, "/marketing/calendar")
  const sellerItems = await dayItems(realSeller)
  await shot(realSeller, "G0-seller-own-calendar"); await realSeller.close()
  for (const [key, label] of [["owner", "team owner"], ["bundle=seller", "seller"]] as const) {
    const vc = await viewAsCtx(key), pv = await open(vc, "/marketing/calendar")
    const tv = await text(pv), items = await dayItems(pv)
    await shot(pv, `G-view-as-${label.replace(" ", "-")}`)
    ck(`G1 View as ${label} reads Rocco's zone (Canary Islands), not Rome`, /Canary Islands/.test(tv) && !/Times are Rome/.test(tv), tv.slice(0, 220))
    ck(`G2 …and shows exactly what his own page shows that day (his Busy time, his TD calendar, the owner's time as Busy)`, sellerItems.length > 0 && JSON.stringify(items) === JSON.stringify(sellerItems), { sellerItems, items })
    await pv.close(); await vc.close()
  }
  {
    const vc = await viewAsCtx("bundle=setter"), pv = await open(vc, "/marketing/calendar"); const tv = await text(pv)
    await pv.getByTestId("cal-view-week").click(); await wd(pv); await pv.waitForTimeout(1500)
    const its = await pv.locator(`[data-day="${D}"] [data-testid=cal-google]`).evaluateAll(e => e.map(x => x.getAttribute("data-tone")))
    ck("G3 View as setter: only the seller's grey Busy blocks, nothing of the owner, no banner", its.length > 0 && its.every(x => x === "busy") && !/New York|America\/New_York/.test(tv + await pv.content()) && (await pv.getByTestId("seller-banner").count()) === 0, its)
    await shot(pv, "G-view-as-setter"); await pv.close(); await vc.close()
    const va = await viewAsCtx("bundle=analyst"), pa = await open(va, "/marketing/calendar"); const ta = await text(pa)
    ck("G3b View as analyst: no Google item at all, no warning, no banner", (await pa.locator("[data-testid=cal-google]").count()) === 0 && (await pa.getByTestId("cal-share-warning").count()) === 0 && (await pa.getByTestId("seller-banner").count()) === 0 && !/Canary Islands/.test(ta), ta.slice(0, 200))
    await pa.close(); await va.close()
  }
  const own = await open(admin, "/marketing/calendar")
  ck("G4 Antonio on his own login still reads New York time", /New York/.test(await text(own)))
  await own.close()

  // ═════ H. the persistent banner (Antonio, 31 Oct 2026: "a persistent banner in Rocco's place with my timezone and his timezone"; the clocks "too big")
  for (const path of ["/marketing/leads", "/marketing/calendar", "/marketing/board", "/marketing/today"]) {
    const pg = await open(seller, path); const tx = await text(pg), bn = pg.getByTestId("seller-banner")
    ck(`H1 seller ${path}: the banner shows his time and Antonio's`, (await bn.count()) === 1 && /Your time/.test(await bn.innerText()) && /Antonio's time/.test(await bn.innerText()) && /Canary Islands/.test(await bn.innerText()) && /New York/.test(await bn.innerText()), tx.slice(0, 160))
    ck(`H2 …and it is slim (one thin bar)`, ((await bn.boundingBox())?.height ?? 999) < 60, await bn.boundingBox())
    if (path === "/marketing/leads") { await shot(pg, "H-seller-banner"); await pg.evaluate(() => window.scrollTo(0, 400)); ck("H3 …and it stays at the top while the page scrolls", ((await bn.boundingBox())?.y ?? 999) < 5, await bn.boundingBox()) }
    await pg.close()
  }
  for (const [path, who, label] of [["/marketing/leads", setter, "the setter"], ["/marketing/calendar", setter, "the setter"], ["/marketing/calendar", admin, "Antonio on his own login"]] as const) {
    const pg = await open(who, path)
    ck(`H4 ${label} ${path}: no banner`, (await pg.getByTestId("seller-banner").count()) === 0)
    await pg.close()
  }
  { const vc = await viewAsCtx("owner"), pv = await open(vc, "/marketing/leads"); const bn = pv.getByTestId("seller-banner")
    ck("H5 View as team owner: the banner is on Rocco's page too (his time and Antonio's)", (await bn.count()) === 1 && /Canary Islands/.test(await bn.innerText()) && /New York/.test(await bn.innerText()))
    await pv.close(); await vc.close() }

  await browser.close(); fake.close(); await db.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
