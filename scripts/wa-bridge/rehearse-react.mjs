// End-to-end REHEARSAL of the CRM → phone reaction sender (dev job 5962e46d, Release 2). SANDBOX ONLY.
// Run from the repo root with the sandbox dev server up on :3000:  node scripts/wa-bridge/rehearse-react.mjs
// The REAL sender (react.mjs) runs unchanged against the real CRM routes + the sandbox database; only the WhatsApp program is a FAKE local
// server that records what it is asked. Nothing real can be sent. Test rows are removed at the end.
import { readFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { createRequire } from "node:module"
const { createClient } = createRequire(import.meta.url)(`${process.cwd()}/node_modules/@supabase/supabase-js/dist/index.cjs`)

const ROOT = process.cwd()
const envText = readFileSync(`${ROOT}/.env.local`, "utf8")
const env = Object.fromEntries(envText.split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")] }))
if (!env.NEXT_PUBLIC_SUPABASE_URL.includes("xjcxlmlpeywtwkhstjlw")) { console.error("NOT SANDBOX — abort"); process.exit(1) }
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

let failures = 0
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  → " + extra}`); if (!ok) failures++ }

// ── the FAKE WhatsApp program ──
const calls = []
let mode = "ok" // ok | error
const fake = createServer((req, res) => {
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    calls.push({ method: req.method, url: req.url, device: req.headers["x-device-id"], auth: req.headers.authorization ? "present" : "missing", body: body ? JSON.parse(body) : null })
    if (mode === "ok") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ code: "SUCCESS", message: "Success", results: {} })) }
    else { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ code: "ERROR", message: "nope" })) }
  })
})
await new Promise((r) => fake.listen(0, "127.0.0.1", r))
const fakePort = fake.address().port

const { data: ch } = await sb.from("messaging_channels").select("id, webhook_secret").eq("provider", "wabridge").limit(1).single()
const { data: groups } = await sb.from("messaging_groups").select("id, external_group_id").eq("channel_id", ch.id).eq("is_active", true).limit(80)
const g = groups.find((x) => /^[0-9]{6,15}(@(s\.whatsapp\.net|c\.us))?$/.test(x.external_group_id))
const digits = g.external_group_id.replace(/@.*$/, "")
const ext = "REACTREH" + Math.floor(Math.random() * 1e9)
const { data: msg } = await sb.from("messages").insert({ channel_id: ch.id, group_id: g.id, direction: "inbound", content_type: "text", content_text: "react rehearsal", created_at: new Date().toISOString(), external_message_id: ext }).select("id").single()
const { data: before } = await sb.from("messaging_groups").select("unread_count, last_message_at").eq("id", g.id).single()
const t0 = new Date().toISOString()
await sb.from("wa_bridge_state").update({ reachable: true, connected: true, logged_in: true, last_heartbeat_at: new Date().toISOString(), reactions_seen_at: new Date().toISOString(), reactions_sender_seen_at: null, reactions_mode: "off", reactions_allowlist: [], reactions_allow_all: false, reactions_min_gap_seconds: 4, reactions_hourly_cap: 40, reactions_daily_cap: 200, reactions_per_chat_hour: 12 }).eq("channel_id", ch.id)
await sb.from("wa_reaction_sync").delete().eq("channel_id", ch.id)
await sb.from("wa_reaction_sends").delete().eq("channel_id", ch.id)

const runSender = (extraEnv = {}) => new Promise((resolve) => {
  const child = spawn("node", [`${ROOT}/scripts/wa-bridge/react.mjs`, "--once"], {
    env: { ...process.env, CHANNEL_ID: ch.id, WEBHOOK_SECRET: ch.webhook_secret, CRM_BASE_URL: "http://127.0.0.1:3000", GOWA_PORT: String(fakePort), GOWA_BASIC_AUTH: "user:pass", ...extraEnv },
  })
  let out = ""
  child.stdout.on("data", (d) => (out += d))
  child.stderr.on("data", (d) => (out += d))
  child.on("close", (code) => { const m = /wait=(\d+)/.exec(out); resolve({ code, wait: m ? Number(m[1]) : null, out }) })
})
const queue = async (emoji, action = "set") => (await sb.rpc("wabridge_queue_phone_reaction", { p_message_id: msg.id, p_emoji: emoji, p_action: action, p_user: "11111111-1111-1111-1111-111111111111" })).data
const lane = async () => (await sb.from("wa_reaction_sync").select("status, desired_emoji, applied_emoji, error, attempts").eq("message_id", msg.id).maybeSingle()).data
const lineEl = async () => ((await sb.from("messages").select("reactions").eq("id", msg.id).single()).data.reactions ?? []).filter((e) => e.reactor_type === "line")
const due = async () => {
  await sb.from("wa_reaction_sync").update({ hold_until: new Date(Date.now() - 1000).toISOString() }).eq("message_id", msg.id)
  await sb.from("wa_reaction_sends").update({ claimed_at: new Date(Date.now() - 60_000).toISOString() }).eq("channel_id", ch.id) // the pacing gap has passed
}

try {
  // 1. switch OFF: nothing queued, the sender idles (paused) and never touches the program
  let q = await queue("👍")
  check("1  OFF by default: the click is not queued", q.ok && q.queued === false && q.reason === "off", JSON.stringify(q))
  let r = await runSender()
  check("2  the sender idles while the switch is off (waits 20 s, no call to the program)", r.code === 0 && r.wait === 20 && calls.length === 0, `${r.code} ${r.wait} ${calls.length} ${r.out}`)

  // 2. switch ON for this number only
  await sb.rpc("wabridge_set_reactions_allowlist", { p_channel_id: ch.id, p_digits: [digits] })
  await sb.rpc("wabridge_set_reactions_mode", { p_channel_id: ch.id, p_mode: "live" })
  await sb.from("wa_bridge_state").update({ reactions_sender_seen_at: new Date(Date.now() - 10 * 60_000).toISOString() }).eq("channel_id", ch.id) // as if the sender had stopped
  q = await queue("👍")
  check("2b ON but the Mac sender has not looked for minutes: the click is refused (never a pick that sits on 'sending…')", q.queued === false && q.reason === "sender_offline", JSON.stringify(q))
  r = await runSender()
  check("2c the sender's first look (idle, nothing due) records that it is alive", r.code === 0 && r.wait === 2 && calls.length === 0, `${r.code} ${r.wait} ${r.out}`)
  q = await queue("👍")
  check("3  now a pick is queued with the 3 s undo hold", q.queued === true && q.hold_seconds === 3, JSON.stringify(q))
  r = await runSender()
  check("4  inside the hold the sender finds nothing due (no call to the program)", r.code === 0 && r.wait === 2 && calls.length === 0, `${r.wait} ${calls.length}`)

  // 3. hold passes → sent through the program with the exact request
  await due()
  r = await runSender()
  const c0 = calls[0]
  check("5  the sender calls the program: right address, device, auth, chat and emoji", calls.length === 1 && c0.method === "POST" && c0.url === `/message/${ext}/reaction` && c0.device === "td-crm" && c0.auth === "present" && c0.body.phone === `${digits}@s.whatsapp.net` && c0.body.emoji === "👍", JSON.stringify(calls))
  let l = await lane()
  check("6  the CRM records it as SENT", l?.status === "sent" && l.applied_emoji === "👍", JSON.stringify(l))
  let el = await lineEl()
  check("7  the green 'phone' pill (source crm) now exists on the message, stamped with the Mac's clock", el.length === 1 && el[0].emoji === "👍" && el[0].source === "crm" && Math.abs(el[0].scan_ms - Date.now()) < 60_000, JSON.stringify(el))
  const { data: ev } = await sb.from("ui_events").select("kind").eq("kind", "whatsapp").gte("created_at", t0)
  check("8  the open Inboxes were woken by the result", (ev ?? []).length >= 1, "no ui_events row")

  // 4. latest pick wins: ❤️ replaces 👍 (after the pacing gap)
  await queue("❤️")
  await due()
  r = await runSender()
  check("9  a newer pick REPLACES the old one on the phone", calls.length === 2 && calls[1].body.emoji === "❤️", JSON.stringify(calls.slice(1)))
  el = await lineEl()
  check("10 still exactly one phone element, now ❤️", el.length === 1 && el[0].emoji === "❤️", JSON.stringify(el))

  // 5. un-picking the one on the phone removes it (empty emoji to the program)
  q = await queue("❤️", "remove")
  await due()
  r = await runSender()
  check("11 un-picking sends an EMPTY emoji (= remove) to the program", calls.length === 3 && calls[2].body.emoji === "", JSON.stringify(calls.slice(2)))
  el = await lineEl()
  check("12 the phone element becomes a removal marker", el.length === 1 && el[0].emoji === "" && !!el[0].removed_at, JSON.stringify(el))

  // 6. the program refuses → failed with its reason; the phone element is untouched
  mode = "error"
  await queue("🙏")
  await due()
  r = await runSender()
  l = await lane()
  check("13 a refusal from the program is recorded as FAILED with its reason", l?.status === "failed" && /nope/.test(l.error ?? ""), JSON.stringify(l))
  el = await lineEl()
  check("14 …and the phone element is NOT changed by a failed send", el.length === 1 && el[0].emoji === "", JSON.stringify(el))

  // 7. the program is unreachable → failed, say so
  mode = "ok"
  fake.close()
  await queue("🙏")
  await due()
  r = await runSender()
  l = await lane()
  check("15 an unreachable program is recorded as FAILED ('could not reach')", l?.status === "failed" && /could not reach/.test(l.error ?? ""), JSON.stringify(l))

  // 8. the phone→CRM reader is not alive → the sender holds everything
  await queue("🙏")
  await due()
  await sb.from("wa_bridge_state").update({ reactions_seen_at: new Date(Date.now() - 10 * 60_000).toISOString() }).eq("channel_id", ch.id)
  const callsBefore = calls.length
  r = await runSender()
  check("16 with the reader not alive the sender waits 20 s and sends nothing", r.wait === 20 && calls.length === callsBefore && (await lane())?.status === "pending", `${r.wait} ${(await lane())?.status}`)

  // 9. a wrong secret is refused by the CRM (nothing happens, the sender reports failure)
  r = await runSender({ WEBHOOK_SECRET: "definitely-not-the-secret" })
  check("17 a wrong secret is refused (exit 1)", r.code === 1 && /401/.test(r.out), `${r.code} ${r.out}`)

  // 10. a reaction never changes unread / last message time
  const { data: after } = await sb.from("messaging_groups").select("unread_count, last_message_at").eq("id", g.id).single()
  check("18 unread count and last_message_at never changed", after.unread_count === before.unread_count && after.last_message_at === before.last_message_at, JSON.stringify({ before, after }))
} finally {
  await sb.from("wa_bridge_state").update({ reactions_mode: "off", reactions_allowlist: [], reactions_allow_all: false }).eq("channel_id", ch.id)
  await sb.from("messages").delete().eq("id", msg.id)
  await sb.from("ui_events").delete().eq("kind", "whatsapp").gte("created_at", t0)
  try { fake.close() } catch {}
  console.log(failures === 0 ? "\nREHEARSAL: ALL PASS (rehearsal rows removed, switch back OFF)" : `\nREHEARSAL: ${failures} FAILURE(S) (rehearsal rows removed, switch back OFF)`)
  process.exit(failures === 0 ? 0 : 1)
}
