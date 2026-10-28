// Rehearsal of the Mac side of "Get a new code" + "Recover missing messages" (dev job 69c6ce32) against the SANDBOX CRM.
// Runs the REAL heartbeat.sh / commands.sh / link-code.sh inside an isolated fake HOME (so no live Mac file is touched), with a
// stand-in for GOWA (the WhatsApp program) on a local port and a stub for the catch-up. Needs the sandbox dev server on :3020.
//
//   node scripts/wa-bridge/rehearse-commands.mjs        (repo root; .env.local must point at the SANDBOX database)
import { spawnSync } from "node:child_process"
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import pg from "pg"
import dotenv from "dotenv"

dotenv.config({ path: path.join(process.cwd(), ".env.local") })
if (!process.env.SUPABASE_DB_URL?.includes("xjcxlmlpeywtwkhstjlw")) throw new Error("not the sandbox database")

const CH = "f25e74d8-e32b-4a5b-afaf-3d384cedf8b4"
const CRM = process.env.REHEARSE_CRM_URL ?? "http://localhost:3020"
const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL })
await db.connect()
const q = async (s, p) => (await db.query(s, p)).rows
const secret = (await q("select webhook_secret from messaging_channels where id=$1", [CH]))[0].webhook_secret

// ── isolated fake HOME with the real scripts ──
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wa-rehearse-"))
const W = path.join(HOME, "wa-bridge")
fs.mkdirSync(path.join(W, "logs"), { recursive: true })
fs.mkdirSync(path.join(W, "storages"), { recursive: true })
const src = path.join(process.cwd(), "scripts/wa-bridge")
for (const f of ["heartbeat.sh", "commands.sh", "link-code.sh"]) fs.copyFileSync(path.join(src, f), path.join(W, f))

// ── stand-in for GOWA: status (logged in or not) + a pairing code endpoint, counting how often a code is asked for ──
let loggedIn = false
let codeAsks = 0
const gowa = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json")
  if (req.url.startsWith("/devices/td-crm/status")) return res.end(JSON.stringify({ code: "SUCCESS", results: { is_connected: loggedIn, is_logged_in: loggedIn } }))
  if (req.url.startsWith("/devices/td-crm/login/code")) { codeAsks++; return res.end(JSON.stringify({ code: "SUCCESS", results: { pair_code: "RHRS-" + String(1000 + codeAsks) } })) }
  res.statusCode = 404; res.end("{}")
})
await new Promise((r) => gowa.listen(0, "127.0.0.1", r))
const GOWA_PORT = gowa.address().port

fs.writeFileSync(path.join(W, "bridge.env"), [
  `CRM_BASE_URL=${CRM}`, `CHANNEL_ID=${CH}`, `WEBHOOK_SECRET=${secret}`, `GOWA_PORT=${GOWA_PORT}`, `GOWA_BASIC_AUTH=x:y`, `LEAD_PHONE=15550000000`,
].join("\n") + "\n")

const run = (script, env = {}) => spawnSync("bash", [path.join(W, script)], { env: { ...process.env, HOME, ...env }, encoding: "utf8", timeout: 120000 })
const log = (f) => { try { return fs.readFileSync(path.join(W, "logs", f), "utf8") } catch { return "" } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const reset = () => q("update wa_bridge_state set link_attempts=0, link_window_at=null, link_code=null, link_code_at=null, link_code_wanted_at=null, recover_requested_at=null, recover_started_at=null, recover_done_at=null, recover_saved=null, recover_read=null, logged_in=false where channel_id=$1", [CH])
const state = async () => (await q("select link_code, link_attempts, link_code_wanted_at, recover_requested_at, recover_started_at, recover_done_at, recover_saved, recover_read from wa_bridge_state where channel_id=$1", [CH]))[0]
let failures = 0
const check = (name, ok, extra = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`) }
const STUB = "echo 'catchup: 6 chats, 26 messages read; 1 saved, 25 already there, 0 unusable'"

try {
  await reset()
  // 1. unlinked, nobody asked → a heartbeat changes nothing and NO code is asked for
  let r = run("heartbeat.sh")
  check("1 heartbeat answered 200", r.stdout.trim().startsWith("200"), r.stdout.trim() + r.stderr.slice(0, 120))
  await wait(2500)
  check("1 nothing asked of WhatsApp while nobody pressed the button", codeAsks === 0 && (await state()).link_code === null)
  r = run("link-code.sh") // what the every-minute loop still does
  check("1 the every-minute reconnect helper does nothing without a request", codeAsks === 0, `codeAsks=${codeAsks}`)

  // 2. the owner pressed "Get a new code" (database call = what the route does) → next beat fetches ONE code
  await q("select wabridge_request_link_code($1)", [CH])
  r = run("heartbeat.sh", { SYNC_CMD: STUB, LINK_SCRIPT: path.join(W, "link-code.sh") })
  await wait(5000)
  const s2 = await state()
  check("2 exactly one code was asked of WhatsApp", codeAsks === 1, `codeAsks=${codeAsks}`)
  check("2 the code reached the CRM", s2.link_code === "RHRS-1001", String(s2.link_code))
  check("2 the request was cleared", s2.link_code_wanted_at === null)
  check("2 the code never appears in the logs", !/RHRS-/.test(log("link-code.log") + log("commands.log")))
  check("2 the reply file was consumed", !fs.existsSync(path.join(W, "storages/hb.json")))

  // 3. a later beat with nothing wanted asks for nothing more
  r = run("heartbeat.sh"); await wait(2500)
  check("3 no second code without a second request", codeAsks === 1, `codeAsks=${codeAsks}`)

  // 4. the 5-per-hour limit holds on the Mac too
  for (let i = 0; i < 6; i++) {
    await q("update wa_bridge_state set link_code_wanted_at=now() where channel_id=$1", [CH])
    fs.rmSync(path.join(W, "storages/commands.lock.d"), { recursive: true, force: true })
    // pretend 40 s passed since the last code so only the hourly limit can stop it
    const f = path.join(W, "storages/link.state"); if (fs.existsSync(f)) { const [a, , w] = fs.readFileSync(f, "utf8").trim().split(/\s+/); fs.writeFileSync(f, `${a} ${Math.floor(Date.now() / 1000) - 40} ${w}\n`) }
    run("heartbeat.sh"); await wait(3500)
  }
  check("4 no more than 5 codes in the hour", codeAsks === 5, `codeAsks=${codeAsks}`)
  check("4 the refusal is logged in plain words", /not asking — 5 codes were already made this hour/.test(log("link-code.log")))

  // 5. recover: pressed → the Mac runs the catch-up once and reports
  await reset(); loggedIn = true
  await q("select wabridge_request_recover($1)", [CH])
  run("heartbeat.sh", { SYNC_CMD: STUB }); await wait(5000)
  const s5 = await state()
  check("5 the result reached the CRM (1 new of 26 read)", s5.recover_done_at !== null && s5.recover_saved === 1 && s5.recover_read === 26, JSON.stringify(s5))
  run("heartbeat.sh", { SYNC_CMD: STUB }); await wait(3000)
  check("5 the job ran only once", (log("commands.log").match(/recover finished/g) ?? []).length === 1)

  // 6. a broken catch-up reports nothing (the screen then says the Mac did not answer) and leaves no lock behind
  await q("select wabridge_request_recover($1)", [CH])
  run("heartbeat.sh", { SYNC_CMD: "echo 'something unexpected'; exit 3" }); await wait(4000)
  const s6 = await state()
  check("6 a catch-up with no summary reports nothing", s6.recover_done_at === null && /gave no summary line/.test(log("commands.log")))
  check("6 no lock left behind", !fs.existsSync(path.join(W, "storages/commands.lock.d")))

  // 7. the CRM is unreachable → the beat fails quietly, no stale reply file, nothing runs
  const envPath = path.join(W, "bridge.env"); const goodEnv = fs.readFileSync(envPath, "utf8")
  fs.writeFileSync(envPath, goodEnv.replace(`CRM_BASE_URL=${CRM}`, "CRM_BASE_URL=http://127.0.0.1:9"))
  r = run("heartbeat.sh")
  fs.writeFileSync(envPath, goodEnv)
  check("7 an unreachable CRM leaves no reply file", !fs.existsSync(path.join(W, "storages/hb.json")) && !fs.existsSync(path.join(W, "storages/hb.json.tmp")))
} finally {
  await reset().catch(() => {})
  gowa.close()
  await db.end()
  fs.rmSync(HOME, { recursive: true, force: true })
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
