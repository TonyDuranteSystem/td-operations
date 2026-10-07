// Pure decisions for the Mac reaction SENDER (dev job 5962e46d, Release 2 — CRM → phone). No I/O: react.mjs does the talking, this file decides
// whether a claim looks sane and how to read the WhatsApp program's answer, so both are unit-tested (tests/unit/wabridge-react-plan.test.ts).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Seconds to wait before asking the CRM again, by the reason it gave for "nothing to send right now". Mirrors lib/messaging/wabridge-react.ts. */
export function backoffSeconds(reason, waitSeconds) {
  switch (reason) {
    case "paused":
    case "unhealthy":
    case "reader_stale":
      return 20
    case "hourly_cap":
    case "daily_cap":
    case "held":
      return 30
    case "gap": {
      const w = Number(waitSeconds)
      return Number.isFinite(w) ? Math.min(Math.max(Math.ceil(w), 2), 60) : 4
    }
    case "in_flight":
      return 5
    default:
      return 4 // idle: look again in 4 s (the undo hold is 10 s, so a pick goes out within ~14 s)
  }
}

/**
 * Check a claimed reaction BEFORE touching WhatsApp. The CRM already validated everything; this is the Mac's own last look, so a
 * malformed answer can never become a request to the program. Returns { ok:true, id, jid, extId, emoji } or { ok:false, reason }.
 * `emoji` may be "" — that means REMOVE the reaction.
 */
export function validateClaim(c) {
  if (typeof c !== "object" || c === null) return { ok: false, reason: "no claim" }
  if (typeof c.id !== "string" || !UUID_RE.test(c.id)) return { ok: false, reason: "bad id" }
  if (typeof c.to_digits !== "string" || !/^[0-9]{6,15}$/.test(c.to_digits)) return { ok: false, reason: "bad number" }
  if (typeof c.external_message_id !== "string" || !/^[A-Za-z0-9]{4,64}$/.test(c.external_message_id)) return { ok: false, reason: "bad message id" }
  if (typeof c.emoji !== "string" || c.emoji.length > 32 || /\s/.test(c.emoji) || /^[A-Za-z0-9]+$/.test(c.emoji)) return { ok: false, reason: "bad emoji" }
  return { ok: true, id: c.id, jid: `${c.to_digits}@s.whatsapp.net`, extId: c.external_message_id, emoji: c.emoji }
}

/** The request body for the program's reaction endpoint (POST /message/{id}/reaction). */
export function reactionPayload(v) {
  return { phone: v.jid, emoji: v.emoji }
}

/**
 * Did the program accept the reaction? Only an explicit success counts: HTTP 200 AND { code: "SUCCESS" } in the body. Anything else
 * (an error status, a different body, no body) is a failure with a short, non-secret reason. A reaction is idempotent on WhatsApp,
 * so a doubtful answer is simply reported as failed and the next click retries.
 */
export function interpretProgramAnswer(httpStatus, bodyText) {
  let json = null
  try { json = bodyText ? JSON.parse(bodyText) : null } catch { json = null }
  if (httpStatus === 200 && json && json.code === "SUCCESS") return { ok: true, error: null }
  const detail = json && typeof json.message === "string" ? json.message : ""
  return { ok: false, error: (detail || `the WhatsApp program answered ${httpStatus || "nothing"}`).slice(0, 200) }
}
