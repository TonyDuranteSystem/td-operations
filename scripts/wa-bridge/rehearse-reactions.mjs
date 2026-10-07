// End-to-end REHEARSAL of the phone → CRM reactions reader (dev job 5962e46d, Release 1). SANDBOX ONLY.
// Runs the REAL reader (reactions.mjs) against a FAKE WhatsApp reaction file and the sandbox CRM (start 
> td-operations@2.0.0 dev
> next dev

  ▲ Next.js 14.2.35
  - Local:        http://localhost:3001
  - Environments: .env.local
  - Experiments (use with caution):
    · instrumentationHook

 ✓ Starting...
 ○ Compiling /instrumentation ...
 ✓ Compiled /instrumentation in 981ms (1036 modules)
 ✓ Ready in 2.8s
[?25h first; it
// serves the new bridge.reactions route against the sandbox database). Creates one rehearsal message, removes it at the end.
// Needs the sandbox NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local; refuses anything that is not the sandbox.
//   node scripts/wa-bridge/rehearse-reactions.mjs        (from the repo root; expect "REHEARSAL: ALL PASS")
// End-to-end rehearsal of release 1 against the SANDBOX CRM (local dev server) with a FAKE WhatsApp reaction file.
// The real reader script (scripts/wa-bridge/reactions.mjs) runs unchanged; only its inputs are rehearsal ones. No secrets printed.
import { readFileSync, rmSync, existsSync } from "node:fs"
import { execFileSync, spawnSync } from "node:child_process"
import { createRequire } from "node:module"
const ROOT = process.cwd() // run from the repo root: node scripts/wa-bridge/rehearse-reactions.mjs
const { createClient } = createRequire(import.meta.url)(`${ROOT}/node_modules/@supabase/supabase-js`)

const envText = readFileSync(`${ROOT}/.env.local`, "utf8")
const env = Object.fromEntries(envText.split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")] }))
if (!env.NEXT_PUBLIC_SUPABASE_URL.includes("xjcxlmlpeywtwkhstjlw")) { console.error("NOT SANDBOX — abort"); process.exit(1) }
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const DB = "/tmp/rehearsal-chatstorage.db"
const STATE = "/tmp/rehearsal-reactions-state.json"
for (const f of [DB, STATE]) if (existsSync(f)) rmSync(f)

let failures = 0
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  → " + extra}`); if (!ok) failures++ }

const { data: ch } = await sb.from("messaging_channels").select("id, webhook_secret").eq("provider", "wabridge").limit(1).single()
const { data: groups } = await sb.from("messaging_groups").select("id, external_group_id").eq("channel_id", ch.id).limit(50)
const g = groups.find((x) => /^[0-9]{6,15}(@(s\.whatsapp\.net|c\.us))?$/.test(x.external_group_id))
const digits = g.external_group_id.replace(/@.*$/, "")
const ext = "REHEARSE" + Math.floor(Math.random() * 1e9)
const { data: msg } = await sb.from("messages").insert({ channel_id: ch.id, group_id: g.id, direction: "outbound", content_type: "text", content_text: "reactions rehearsal", created_at: new Date().toISOString(), external_message_id: ext }).select("id").single()
const { data: before } = await sb.from("messaging_groups").select("unread_count, last_message_at").eq("id", g.id).single()
await sb.from("wa_bridge_state").update({ reachable: true, connected: true, logged_in: true, last_heartbeat_at: new Date().toISOString() }).eq("channel_id", ch.id)

// fake WhatsApp file with the same layout as the real one
const sqlite = (q) => execFileSync("sqlite3", [DB, q], { encoding: "utf8" })
sqlite(`CREATE TABLE messages (id VARCHAR(255) NOT NULL, chat_jid VARCHAR(255) NOT NULL, content TEXT);
CREATE TABLE message_reactions (message_id VARCHAR(255) NOT NULL, chat_jid VARCHAR(255) NOT NULL, device_id VARCHAR(255) NOT NULL DEFAULT '', reactor_jid VARCHAR(255) NOT NULL, emoji TEXT NOT NULL DEFAULT '', is_from_me BOOLEAN DEFAULT FALSE, reaction_timestamp TIMESTAMP NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (message_id, reactor_jid, device_id));
INSERT INTO messages (id, chat_jid) VALUES ('${ext}', '${digits}@s.whatsapp.net');
INSERT INTO messages (id, chat_jid) VALUES ('OTHERMSG0001', '393290000001@s.whatsapp.net');
INSERT INTO message_reactions (message_id, chat_jid, device_id, reactor_jid, emoji, is_from_me, reaction_timestamp, updated_at) VALUES ('OTHERMSG0001', '393290000001@s.whatsapp.net', 'dev', '393290000001@s.whatsapp.net', '🤝', 0, '2026-10-01 10:00:00+00:00', '2026-10-01 10:00:00+00:00');`)

const runReader = (extra = []) => {
  const r = spawnSync("node", [`${ROOT}/scripts/wa-bridge/reactions.mjs`, "--once", ...extra], {
    encoding: "utf8",
    env: { ...process.env, CHANNEL_ID: ch.id, WEBHOOK_SECRET: ch.webhook_secret, CRM_BASE_URL: "http://127.0.0.1:3000", REACTIONS_DB: DB, REACTIONS_STATE: STATE },
  })
  const line = (r.stdout + r.stderr).trim().split("\n").pop() || ""
  return { code: r.status, line: line.replace(/^\S+ /, "") }
}
const reactions = async () => (await sb.from("messages").select("reactions").eq("id", msg.id).single()).data.reactions
const side = (arr, s) => arr.find((e) => e.reactor_type === s)
const stamp = new Date().toISOString().replace("T", " ").replace("Z", "+00:00")

try {
  // 1. client reacts
  sqlite(`INSERT INTO message_reactions (message_id, chat_jid, device_id, reactor_jid, emoji, is_from_me, reaction_timestamp, updated_at) VALUES ('${ext}', '${digits}@s.whatsapp.net', 'dev', '${digits}@s.whatsapp.net', '❤️', 0, '${stamp}', '${stamp}');`)
  let r = runReader(); console.log("scan 1:", r.line)
  let rx = await reactions()
  check("1  client ❤️ appears in the CRM", side(rx, "client")?.emoji === "❤️" && side(rx, "client")?.source === "phone", JSON.stringify(rx))
  const beat = (await sb.from("wa_bridge_state").select("reactions_seen_at").eq("channel_id", ch.id).single()).data.reactions_seen_at
  check("2  the 'alive' beat was recorded", !!beat && Date.now() - Date.parse(beat) < 60_000, String(beat))

  // 2. nothing changed → quiet scan (empty batch = beat), CRM unchanged
  r = runReader(); console.log("scan 2:", r.line)
  check("3  a quiet scan reports only the still-unmatched item (retry by design) and succeeds", r.code === 0 && /1 reported → unmatched:1/.test(r.line), r.line)

  // 3. client changes it → same slot updated
  sqlite(`UPDATE message_reactions SET emoji='😂', reaction_timestamp='${stamp.replace(/\d\d\+/, "59+")}', updated_at=datetime('now') WHERE message_id='${ext}';`)
  r = runReader(); console.log("scan 3:", r.line)
  rx = await reactions()
  check("4  the change updates the same slot (still one client element)", rx.filter((e) => e.reactor_type === "client").length === 1 && side(rx, "client")?.emoji === "😂", JSON.stringify(rx))

  // 4. business line reacts natively too
  sqlite(`INSERT INTO message_reactions (message_id, chat_jid, device_id, reactor_jid, emoji, is_from_me, reaction_timestamp, updated_at) VALUES ('${ext}', '${digits}@s.whatsapp.net', 'dev', '17274521093@s.whatsapp.net', '👍', 1, '${stamp}', '${stamp}');`)
  r = runReader(); console.log("scan 4:", r.line)
  rx = await reactions()
  check("5  the business line's reaction shows beside the client's", side(rx, "line")?.emoji === "👍" && side(rx, "client")?.emoji === "😂", JSON.stringify(rx))

  // 5. client removes it: first scan debounces, second scan removes
  sqlite(`DELETE FROM message_reactions WHERE message_id='${ext}' AND is_from_me=0;`)
  r = runReader(); console.log("scan 5 (first scan missing):", r.line)
  rx = await reactions()
  check("6  a removal is NOT applied on the first missing scan (debounce)", side(rx, "client")?.emoji === "😂", JSON.stringify(rx))
  r = runReader(); console.log("scan 6 (second scan missing):", r.line)
  rx = await reactions()
  check("7  the removal applies on the second scan (tombstone, line untouched)", side(rx, "client")?.emoji === "" && side(rx, "line")?.emoji === "👍", JSON.stringify(rx))

  // 6. an UNHEALTHY bridge holds removals
  sqlite(`DELETE FROM message_reactions WHERE message_id='${ext}';`)
  await sb.from("wa_bridge_state").update({ last_heartbeat_at: new Date(Date.now() - 10 * 60_000).toISOString() }).eq("channel_id", ch.id)
  r = runReader(); r = runReader(); console.log("scans 7-8 (bridge unhealthy):", r.line)
  rx = await reactions()
  check("8  while the bridge is unhealthy the line removal is HELD (reaction stays)", side(rx, "line")?.emoji === "👍", JSON.stringify(rx))
  await sb.from("wa_bridge_state").update({ last_heartbeat_at: new Date().toISOString() }).eq("channel_id", ch.id)
  r = runReader(); console.log("scan 9 (healthy again):", r.line)
  rx = await reactions()
  check("9  once healthy again the held removal applies", side(rx, "line")?.emoji === "", JSON.stringify(rx))

  // 7. an empty file read after reactions were reported is a failed read, never 'all removed'
  sqlite(`INSERT INTO message_reactions (message_id, chat_jid, device_id, reactor_jid, emoji, is_from_me, reaction_timestamp, updated_at) VALUES ('${ext}', '${digits}@s.whatsapp.net', 'dev', '${digits}@s.whatsapp.net', '🙏', 0, '${stamp}', '${stamp}');`)
  r = runReader()
  sqlite(`DELETE FROM message_reactions;`)
  r = runReader(); console.log("scan 11 (file now empty):", r.line)
  rx = await reactions()
  check("10 an EMPTY read is refused as a failed read (exit 1) and nothing is removed", r.code === 1 && side(rx, "client")?.emoji === "🙏", `${r.code} ${JSON.stringify(rx)}`)

  // 8. layout change → fail closed
  sqlite(`ALTER TABLE message_reactions ADD COLUMN surprise TEXT;`)
  r = runReader(); console.log("scan 12 (layout changed):", r.line)
  check("11 a changed file layout stops the reader (fail closed)", r.code === 1 && /layout changed/.test(r.line), r.line)

  // 9. the staff-only fields of the message are untouched
  const { data: after } = await sb.from("messaging_groups").select("unread_count, last_message_at").eq("id", g.id).single()
  check("12 unread count and last_message_at never changed", after.unread_count === before.unread_count && after.last_message_at === before.last_message_at, JSON.stringify({ before, after }))
} finally {
  await sb.from("messages").delete().eq("id", msg.id)
  for (const f of [DB, STATE]) if (existsSync(f)) rmSync(f)
  console.log(failures === 0 ? "\nREHEARSAL: ALL PASS (rehearsal message removed)" : `\nREHEARSAL: ${failures} FAILURE(S) (rehearsal message removed)`)
  process.exit(failures === 0 ? 0 : 1)
}
