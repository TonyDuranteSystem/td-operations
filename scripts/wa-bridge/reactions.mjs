#!/usr/bin/env node
// Phone → CRM reactions reader (dev job 5962e46d, Release 1). Lives on the Mac next to the WhatsApp program (GOWA).
// ONE scan per run:
//   1. read GOWA's own reaction records READ-ONLY (sqlite3 CLI, -readonly — it never writes, never blocks GOWA),
//   2. check the layout is the one this was written for (fail CLOSED on any difference or read problem),
//   3. work out what changed since the CRM last acknowledged (reactions-plan.mjs — pure, unit-tested),
//   4. post a signed `bridge.reactions` batch to the CRM (even an EMPTY one — it is the "I am alive and scanning" beat),
//   5. fold the CRM's per-item answers into a small state file.
// It SENDS NOTHING to WhatsApp and writes nothing to GOWA's files. A missed scan self-heals on the next one.
//
//   node reactions.mjs --once [--dry] [--accept-removals]
//     --dry               print what WOULD be posted; post nothing, save no state
//     --accept-removals   one-off: let this scan report more than the usual few removals (a person checked them)
//
// Env (explicit variables win over bridge.env — used to rehearse against the sandbox with a fixture file):
//   CHANNEL_ID WEBHOOK_SECRET CRM_BASE_URL   REACTIONS_DB (default ~/wa-bridge/storages/chatstorage.db)
//   REACTIONS_STATE (default ~/wa-bridge/storages/reactions-state.json)   REACTIONS_ONCE=1 same as --once
// Exit codes: 0 scan done, 1 read/layout/post failure (nothing reported or state moved), 2 bad usage.
import { createHmac } from "node:crypto"
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import {
  emptyState, planScan, applyResults, absentMessageIds, currentReactions, toBatches, fingerprintOk,
} from "./reactions-plan.mjs"

const HOME = homedir()
const args = process.argv.slice(2)
const dry = args.includes("--dry")
const acceptRemovals = args.includes("--accept-removals")
const known = new Set(["--once", "--dry", "--accept-removals"])
for (const a of args) if (!known.has(a)) { console.error(`unknown option ${a}`); process.exit(2) }

const log = (msg) => console.log(`${new Date().toISOString()} reactions: ${msg}`)

const env = {}
try {
  for (const l of readFileSync(`${HOME}/wa-bridge/bridge.env`, "utf8").split("\n")) {
    const m = l.match(/^([A-Z_]+)=(.*)$/)
    if (m) env[m[1]] = m[2].replace(/^"|"$/g, "")
  }
} catch { /* bridge.env missing is only fatal when we need to post */ }
for (const k of ["CHANNEL_ID", "WEBHOOK_SECRET", "CRM_BASE_URL"]) if (process.env[k]) env[k] = process.env[k]

const DB = process.env.REACTIONS_DB || `${HOME}/wa-bridge/storages/chatstorage.db`
const STATE_FILE = process.env.REACTIONS_STATE || `${HOME}/wa-bridge/storages/reactions-state.json`

let bypass = ""
try { bypass = readFileSync(`${HOME}/wa-bridge/vercel-bypass.txt`, "utf8").trim() } catch {}
let CRM = ""
if (!dry) {
  if (!env.CRM_BASE_URL || !env.CHANNEL_ID || !env.WEBHOOK_SECRET) { log("FAIL: CHANNEL_ID / WEBHOOK_SECRET / CRM_BASE_URL not set"); process.exit(1) }
  CRM = `${env.CRM_BASE_URL}/api/wa-bridge/${env.CHANNEL_ID}`
  if (env.CRM_BASE_URL.includes("sandbox") && bypass) CRM += `?x-vercel-protection-bypass=${bypass}`
}

/** One sqlite3 call, read-only, JSON out. Any problem (locked, missing, bad output) throws — the caller fails closed. */
function sql(query) {
  const out = execFileSync("sqlite3", ["-readonly", "-json", "-cmd", ".timeout 4000", DB, query], {
    encoding: "utf8", timeout: 20000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  })
  const t = out.trim()
  return t === "" ? [] : JSON.parse(t)
}

function loadState() {
  if (!existsSync(STATE_FILE)) return emptyState()
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"))
    return { acked: s.acked ?? {}, tries: s.tries ?? {}, absent: s.absent ?? {}, emptyScans: s.emptyScans ?? 0 }
  } catch {
    // An unreadable state file would make us re-report everything (harmless: the CRM ignores equal reactions) — but say so.
    log("WARN: state file unreadable — starting fresh (the CRM ignores anything it already has)")
    return emptyState()
  }
}
function saveState(state) {
  const tmp = `${STATE_FILE}.tmp`
  writeFileSync(tmp, JSON.stringify(state))
  renameSync(tmp, STATE_FILE)
}

async function post(scanMs, items) {
  const body = JSON.stringify({ event: "bridge.reactions", ts: Date.now(), scan_ms: scanMs, items })
  const sig = "sha256=" + createHmac("sha256", env.WEBHOOK_SECRET).update(body).digest("hex")
  const r = await fetch(CRM, { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body, signal: AbortSignal.timeout(45000) })
  const text = await r.text()
  if (!r.ok) throw new Error(`CRM answered ${r.status}: ${text.slice(0, 160)}`)
  const parsed = JSON.parse(text)
  if (parsed.ok !== true || !Array.isArray(parsed.results)) throw new Error("CRM answer has no per-item results")
  return parsed.results
}

async function main() {
  const scanMs = Date.now() // the ONE clock: when this snapshot was taken

  // 1+2. Layout check, then ONE statement that reads every reaction together with its parent message.
  const cols = sql("PRAGMA table_info(message_reactions)").map((c) => c.name)
  if (!fingerprintOk(cols)) { log(`FAIL: the reaction table's layout changed (${cols.join(",") || "no table"}) — not reading until reviewed`); return 1 }
  const msgCols = sql("PRAGMA table_info(messages)").map((c) => c.name)
  if (!msgCols.includes("id") || !msgCols.includes("chat_jid")) { log("FAIL: the messages table's layout changed — not reading until reviewed"); return 1 }
  const rows = sql(
    "SELECT r.message_id, r.chat_jid, r.reactor_jid, r.emoji, r.is_from_me, r.reaction_timestamp, r.updated_at " +
    "FROM message_reactions r",
  )

  const state = loadState()

  // 3. Which previously reported reactions vanished, and do their parent messages still exist?
  const probeIds = absentMessageIds(currentReactions(rows), state)
  let existingParentIds = new Set()
  if (probeIds.length > 0) {
    // ids are program-generated hex strings; still, only ever interpolate what passes a strict pattern
    const safe = probeIds.filter((id) => /^[A-Za-z0-9]{4,64}$/.test(id))
    if (safe.length > 0) {
      const found = sql(`SELECT DISTINCT id FROM messages WHERE id IN (${safe.map((id) => `'${id}'`).join(",")})`)
      existingParentIds = new Set(found.map((f) => f.id))
    }
  }

  const plan = planScan({ rows, state, existingParentIds, acceptRemovals })
  if (plan.skip) {
    log(`SKIP: ${plan.reason} — nothing reported`)
    if (!dry) saveState(plan.nextState) // remembers how many empty scans in a row
    return 1
  }
  if (plan.guard.tripped) log(`ALERT: ${plan.guard.removals} removals in one scan — refused (rerun with --accept-removals after checking)`)

  const mask = (it) => `${it.op} ${it.side} ${it.op === "set" ? it.emoji : ""} msg …${it.ext_id.slice(-4)} chat …${it.chat.slice(-4)}`
  if (dry) {
    log(`DRY: ${rows.length} reaction rows, ${plan.items.length} item(s) would be reported${plan.guard.tripped ? " (removals refused by the guard)" : ""}`)
    for (const it of plan.items) log(`  would report: ${mask(it)}`)
    return 0
  }

  // 4+5. Post (an empty batch is the beat), then fold the per-item answers into the state.
  let next = plan.nextState
  const batches = plan.items.length === 0 ? [{ items: [], keys: [] }] : toBatches(plan.items, plan.keys)
  const counts = {}
  for (const b of batches) {
    const results = await post(scanMs, b.items)
    for (const r of results) counts[r.r] = (counts[r.r] ?? 0) + 1
    next = applyResults({ state: next, plan: b, results, current: plan.current })
  }
  saveState(next)
  log(`ok: ${rows.length} rows, ${plan.items.length} reported${Object.keys(counts).length ? " → " + Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(" ") : ""}`)
  return 0
}

main().then((code) => process.exit(code)).catch((e) => { log(`FAIL: ${e instanceof Error ? e.message : String(e)}`); process.exit(1) })
