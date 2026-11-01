/**
 * POST /api/crm/leads/[id]/draft   body: { channel: "whatsapp"|"email", mode?: "draft"|"rewrite"|"check", instruction?, current_text? }
 *
 * The follow-up draft and the rewrite assistant of the lead window (dev job 6fc63c52, phase E). Staff only.
 * It NEVER sends anything: it returns text for a person to read, edit and send through the existing send paths.
 *   draft   — write a first message from the lead's story (a closed list of facts, see lib/leads/lead-draft.ts)
 *   rewrite — apply the person's instruction to the text they have
 *   check   — list what in the text is not supported by the story (nothing is rewritten)
 * A draft or rewrite that breaks a safety rule (a number, link or promise that is not in the story, wrong language,
 * markdown, an introduction) is refused with a plain reason and the person's text is left alone.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { checkRateLimit } from "@/lib/portal/rate-limit"
import { callAI } from "@/lib/portal/ai-provider"
import { loadLeadWindowData, loadLeadMessageEvents, findWhatsAppReplyTarget } from "@/lib/leads/window-loader"
import { leadSendEnabled } from "@/lib/leads/flags"
import {
  buildDraftFacts, buildDraftSystemPrompt, buildDraftUserPrompt, parseDraftOutput, parseReviewOutput, validateLeadDraft,
  draftLanguage, notPromisedLines, type DraftChannel, type DraftMode,
} from "@/lib/leads/lead-draft"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_INSTRUCTION = 600
const MAX_TEXT = 6000

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  if (!UUID.test(params.id)) return NextResponse.json({ error: "That is not a valid lead id." }, { status: 400 })

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const channel = body.channel as DraftChannel
  const mode = ((body.mode as DraftMode) ?? "draft") as DraftMode
  if (channel !== "whatsapp" && channel !== "email") return NextResponse.json({ error: "The channel must be whatsapp or email." }, { status: 400 })
  if (!["draft", "rewrite", "check"].includes(mode)) return NextResponse.json({ error: "The mode must be draft, rewrite or check." }, { status: 400 })
  const instruction = typeof body.instruction === "string" ? body.instruction.trim().slice(0, MAX_INSTRUCTION) : ""
  const currentText = typeof body.current_text === "string" ? body.current_text.slice(0, MAX_TEXT) : ""
  if (mode !== "draft" && !currentText.trim()) return NextResponse.json({ error: "There is no text to work on yet." }, { status: 400 })
  if (mode === "rewrite" && !instruction) return NextResponse.json({ error: "Tell the assistant what to change." }, { status: 400 })

  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: "The AI assistant is not configured." }, { status: 503 })

  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    const rl = checkRateLimit(`lead-draft:${user?.id ?? "unknown"}`, 12, 60_000)
    if (!rl.allowed) return NextResponse.json({ error: `Too many requests. Please wait ${rl.retryAfter ?? 30} seconds.` }, { status: 429 })

    const loaded = await loadLeadWindowData(supabase, supabaseAdmin, params.id)
    if (!loaded.data) return NextResponse.json({ error: loaded.error }, { status: loaded.status })
    const data = loaded.data
    // A chat matched only by a phone number may belong to someone else who shares it: it stays in the story as a
    // 'possible' line but never reaches the AI.
    const messages = ((await loadLeadMessageEvents(supabaseAdmin, params.id)).events ?? []).filter(m => m.matchReason !== "matched by phone number")
    const facts = buildDraftFacts(data, messages)
    const lang = draftLanguage(data.lead.language)

    // Where each channel can be sent from, so the window can say so before the person tries.
    const reply = channel === "whatsapp" ? await findWhatsAppReplyTarget(supabaseAdmin, params.id) : null
    const sendOn = leadSendEnabled()
    const switchedOff = "Sending from here is switched off. Copy the text and send it by hand."
    const target = channel === "whatsapp"
      ? { to: reply?.label ?? data.lead.phone, canSend: sendOn && !!reply?.conversationId && !!data.lead.phone, conversationId: reply?.conversationId ?? null, reason: !sendOn ? switchedOff : reply?.conversationId ? "" : (reply?.reason ?? "") }
      : { to: data.lead.email, canSend: sendOn && !!data.lead.email, conversationId: null, reason: !sendOn ? switchedOff : data.lead.email ? "" : "This lead has no email address." }

    const system = buildDraftSystemPrompt(channel, lang.name, mode)
    const ask = (extra?: string) => callAI({
      systemPrompt: system,
      userPrompt: buildDraftUserPrompt({ facts, mode, instruction: extra ? `${instruction}\n${extra}` : instruction, currentText }),
      maxTokens: mode === "check" ? 500 : 900,
      temperature: mode === "check" ? 0 : 0.3,
      timeoutMs: 25_000,
    })

    if (mode === "check") {
      const r = await ask()
      return NextResponse.json({ review: parseReviewOutput(r.text), language: lang.name, target })
    }

    // Only staff-side facts, the instruction and the text being rewritten count as permission for a number, link or promise.
    const allowed = `${facts.trusted.join("\n")}\n${instruction}\n${currentText}`
    let lastMessage = "The assistant could not write a safe message. Your text was left as it is."
    let extra: string | undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await ask(extra)
      const parsed = parseDraftOutput(r.text)
      if (!parsed) { lastMessage = "The assistant did not answer in the expected form. Your text was left as it is."; extra = "Answer only with the tagged message."; continue }
      const v = validateLeadDraft({ text: parsed.text, subject: parsed.subject, allowed, channel, language: lang.code })
      if (v.ok) {
        return NextResponse.json({
          text: parsed.text,
          subject: channel === "email" ? (parsed.subject || "Following up") : null,
          placeholders: v.placeholders,
          language: lang.name,
          based_on: [...facts.trusted, ...facts.context],
          not_promised: notPromisedLines(data, v.placeholders),
          target,
        })
      }
      lastMessage = v.message
      extra = `Your last answer was refused: ${v.message.replace(" Your text was left as it is.", "")} Fix exactly that.`
    }
    return NextResponse.json({ error: lastMessage }, { status: 422 })
  } catch (err) {
    console.error("[leads/draft] unexpected error:", err)
    return NextResponse.json({ error: "Could not reach the AI assistant — please try again." }, { status: 502 })
  }
}
