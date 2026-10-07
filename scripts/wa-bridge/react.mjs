#!/usr/bin/env node
// CRM → phone reaction SENDER (dev job 5962e46d, Release 2). Lives on the Mac next to the WhatsApp program (GOWA); its OWN always-on job
// (react-loop.sh), never part of send-loop.sh / agent-loop.sh — a slow reaction must not delay a reply or the health beat.
//
// ONE round per run:
//   1. ask the CRM for the next DUE reaction (signed "bridge.react.claim"). The CRM decides EVERYTHING — switch, allowlist, health, that the
//      phone→CRM reader is alive, the 10 s undo hold, pacing, caps, expiry — and hands over at most ONE reaction.
//   2. look at the claim once more (react-plan.mjs validateClaim), then call the program: POST /message/{id}/reaction {phone, emoji}
//      (an EMPTY emoji removes the reaction).
//   3. report the result (signed "bridge.react.result", echoing the claim number). A reaction is idempotent on WhatsApp, so there is no
//      "unknown" state: anything but an explicit success is reported failed (a timeout says "it may or may not have been delivered") and the
//      next pick retries.
// It never writes a log line containing the emoji or the number — ids and a short status only.
//
//   node react.mjs --once            one round, then exit (the loop script calls this)
//   node react.mjs --once --dry      claim NOTHING; only check the CRM answers (no state change anywhere)
// Env overrides (used to rehearse against the sandbox with a FAKE program):
//   CHANNEL_ID WEBHOOK_SECRET CRM_BASE_URL GOWA_PORT GOWA_BASIC_AUTH REACT_DEVICE
// Exit codes: 0 round done (waited seconds printed as "wait=<n>"), 1 the CRM / program did not answer, 2 bad usage.
import { createHmac } from "node:crypto"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { backoffSeconds, validateClaim, reactionPayload, interpretProgramAnswer } from "./react-plan.mjs"

const HOME = homedir()
const args = process.argv.slice(2)
const dry = args.includes("--dry")
for (const a of args) if (!["--once", "--dry"].includes(a)) { console.error(`unknown option ${a}`); process.exit(2) }

const log = (msg) => console.log(`${new Date().toISOString()} react: ${msg}`)

const env = {}
try {
  for (const l of readFileSync(`${HOME}/wa-bridge/bridge.env`, "utf8").split("\n")) {
    const m = l.match(/^([A-Z_]+)=(.*)$/)
    if (m) env[m[1]] = m[2].replace(/^"|"$/g, "")
  }
} catch { /* bridge.env missing is only fatal when we need it */ }
for (const k of ["CHANNEL_ID", "WEBHOOK_SECRET", "CRM_BASE_URL", "GOWA_PORT", "GOWA_BASIC_AUTH"]) if (process.env[k]) env[k] = process.env[k]
for (const k of ["CHANNEL_ID", "WEBHOOK_SECRET", "CRM_BASE_URL", "GOWA_PORT", "GOWA_BASIC_AUTH"]) {
  if (!env[k]) { log(`FAIL: ${k} is not set`); process.exit(1) }
}
const DEVICE = process.env.REACT_DEVICE || "td-crm"
let bypass = ""
try { bypass = readFileSync(`${HOME}/wa-bridge/vercel-bypass.txt`, "utf8").trim() } catch {}
let CRM = `${env.CRM_BASE_URL}/api/wa-bridge/${env.CHANNEL_ID}`
if (env.CRM_BASE_URL.includes("sandbox") && bypass) CRM += `?x-vercel-protection-bypass=${bypass}`
const GOWA = `http://127.0.0.1:${env.GOWA_PORT}`

async function post(event, extra = {}) {
  const body = JSON.stringify({ event, ts: Date.now(), ...extra })
  const sig = "sha256=" + createHmac("sha256", env.WEBHOOK_SECRET).update(body).digest("hex")
  const r = await fetch(CRM, { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body, signal: AbortSignal.timeout(25000) })
  const text = await r.text()
  if (!r.ok) throw new Error(`CRM answered ${r.status}`)
  return JSON.parse(text)
}

async function round() {
  const claim = await post("bridge.react.claim")
  if (claim.claimed !== true) return backoffSeconds(claim.reason, claim.wait_seconds)
  if (dry) { log("DRY: the CRM has a reaction due — NOT sending (dry run)"); return 2 }

  const v = validateClaim(claim)
  if (!v.ok) {
    log(`claimed ${String(claim.id).slice(0, 8)} but it looked wrong (${v.reason}) — reporting it failed`)
    if (typeof claim.id === "string" && Number.isInteger(claim.attempt)) await post("bridge.react.result", { id: claim.id, attempt: claim.attempt, ok: false, error: "the reaction request was malformed" }).catch(() => {})
    return 3
  }
  log(`claimed ${v.id.slice(0, 8)} (${v.emoji === "" ? "remove" : "set"})`)

  let ans
  try {
    const r = await fetch(`${GOWA}/message/${encodeURIComponent(v.extId)}/reaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Id": DEVICE, Authorization: "Basic " + Buffer.from(env.GOWA_BASIC_AUTH).toString("base64") },
      body: JSON.stringify(reactionPayload(v)),
      signal: AbortSignal.timeout(30000),
    })
    ans = interpretProgramAnswer(r.status, await r.text())
  } catch (e) {
    ans = { ok: false, error: e instanceof Error && e.name === "TimeoutError" ? "no answer from the WhatsApp program — it may or may not have been delivered; check the phone" : "could not reach the WhatsApp program" }
  }
  await post("bridge.react.result", ans.ok ? { id: v.id, attempt: v.attempt, ok: true } : { id: v.id, attempt: v.attempt, ok: false, error: ans.error })
  log(`${v.id.slice(0, 8)} ${ans.ok ? "sent" : "FAILED: " + ans.error}`)
  return 3
}

round()
  .then((wait) => { console.log(`wait=${wait}`); process.exit(0) })
  .catch((e) => { log(`FAIL: ${e instanceof Error ? e.message : String(e)}`); console.log("wait=15"); process.exit(1) })
