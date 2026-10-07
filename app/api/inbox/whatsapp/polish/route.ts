import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { checkRateLimit } from "@/lib/portal/rate-limit"
import { callAI } from "@/lib/portal/ai-provider"
import {
  POLISH_MAX_DRAFT_CHARS,
  WHATSAPP_POLISH_SYSTEM_PROMPT,
  buildPolishUserPrompt,
  polishMaxTokens,
  validatePolishResult,
} from "@/lib/inbox/ai-email"

export const dynamic = "force-dynamic"
// callAI can run two ~30s attempts (Sonnet, then Opus).
export const maxDuration = 60

/**
 * POST /api/inbox/whatsapp/polish — the WhatsApp composer's sparkle when the box already has text.
 *
 * Body: { text }. ONLY that text goes to the model: no chat, no CRM, no knowledge base, nothing to invent
 * from (Antonio, 2026-10-07: the old sparkle replaced what he typed with its own draft). The result is
 * checked by validatePolishResult — the same checks the email composer uses (numbers, links, language,
 * length, markdown, placeholders, questions). A result that fails is a 422 and his text is left alone.
 * An EMPTY box is not handled here: that still drafts a reply from the chat via /api/inbox/whatsapp-new/suggest.
 *
 * Every response is JSON; errors carry a plain-language `error` the composer shows as-is (R099).
 */
export async function POST(request: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // Per STAFF MEMBER, not per IP (the whole office shares one IP) — same bucket size as the email polish.
  const rl = checkRateLimit(`wa-polish:${user?.id ?? "anon"}`, 12, 60_000)
  if (!rl.allowed) {
    const wait = rl.retryAfter ?? 10
    return NextResponse.json(
      { error: `You're going a bit fast — please wait ${wait} seconds and try again.`, code: "rate_limited", retryAfter: wait },
      { status: 429, headers: { "Retry-After": String(wait) } },
    )
  }

  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: "AI is not configured on this server." }, { status: 503 })
  }

  let body: { text?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 })
  }
  const text = typeof body.text === "string" ? body.text : ""
  if (!text.trim()) {
    return NextResponse.json({ error: "Type something first — there is nothing to polish." }, { status: 400 })
  }
  if (text.length > POLISH_MAX_DRAFT_CHARS) {
    return NextResponse.json(
      { error: `This text is too long to polish in one go (${text.length.toLocaleString()} characters; the limit is ${POLISH_MAX_DRAFT_CHARS.toLocaleString()}). Polish it in parts.`, code: "too_long" },
      { status: 400 },
    )
  }

  try {
    // temperature is only honoured on the Sonnet attempt (callAI drops it on the Opus fallback);
    // the validator below, not the temperature, is the safety gate.
    const result = await callAI({
      systemPrompt: WHATSAPP_POLISH_SYSTEM_PROMPT,
      userPrompt: buildPolishUserPrompt(text),
      maxTokens: polishMaxTokens(text),
      temperature: 0.2,
    })
    const checked = validatePolishResult(text, result.text)
    if ("code" in checked) {
      return NextResponse.json({ error: checked.message, code: `rejected_${checked.code}` }, { status: 422 })
    }
    return NextResponse.json({ result: checked.text, changed: checked.changed, provider: result.provider })
  } catch (err) {
    console.error("[whatsapp-polish] failed:", err)
    return NextResponse.json({ error: "The AI could not polish that right now — your text was left as it is. Please try again." }, { status: 502 })
  }
}
