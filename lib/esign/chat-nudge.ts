/**
 * Post a signature nudge into the client's portal chat thread.
 *
 * Antonio, 2026-07-31: a reminder must also land in the portal chat, not only
 * as a notification — the chat is where the client actually talks to us, so a
 * nudge that never appears there is invisible in the conversation they read.
 *
 * DELIBERATELY DOES NOT NOTIFY. The caller has already raised exactly one
 * notification for this nudge (a portal signer gets the "document to sign"
 * bell + push + digest email; an email signer gets the invite email). Firing
 * `createPortalNotification` or `notifyClientOfAdminMessage` here as well would
 * give the client two bells and two emails for a single reminder — the spam
 * shape this whole change exists to avoid. This function adds VISIBILITY in
 * the thread, not another interruption.
 *
 * Written as an `admin` message rather than a `system` one on purpose: system
 * messages are staff-side context, explicitly excluded from ever reaching the
 * client, and their emitter is idempotent per source row — so a second reminder
 * would be silently swallowed. A nudge is addressed TO the client and must be
 * repeatable.
 *
 * Best-effort throughout: a chat write must never fail a reminder that has
 * already gone out.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { localeFromLanguage } from "@/lib/locale"
import { PORTAL_BASE_URL } from "@/lib/config"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

/** The "Tony Durante Team" author every server-sent client message uses. */
const ADMIN_SENDER_ID = "b0da5d9c-acf6-4761-9cae-2c3b14dbc631"

/** One stable thread per client for signature chasing. */
const TOPIC = { en: "Documents to sign", it: "Documenti da firmare" } as const

export type ChatNudgeKind = "reminder" | "reopened"

function buildBody(kind: ChatNudgeKind, documentName: string, locale: "en" | "it"): string {
  const link = `${PORTAL_BASE_URL}/portal/sign`
  if (locale === "it") {
    return kind === "reopened"
      ? `Abbiamo riaperto il documento "${documentName}": puoi firmarlo di nuovo quando vuoi.\n\nLo trovi qui: ${link}`
      : `Ti ricordiamo che il documento "${documentName}" è ancora in attesa della tua firma.\n\nPuoi firmarlo qui: ${link}`
  }
  return kind === "reopened"
    ? `We've reopened the document "${documentName}" — you can sign it again whenever you're ready.\n\nYou'll find it here: ${link}`
    : `Just a reminder that the document "${documentName}" is still waiting for your signature.\n\nYou can sign it here: ${link}`
}

/**
 * Post the nudge. No-ops (returning false) when there is no client thread to
 * post into — a third-party signer with no CRM contact has no portal.
 */
export async function postSignatureChatNudge(opts: {
  contactId: string | null | undefined
  accountId: string | null | undefined
  documentName: string | null | undefined
  kind: ChatNudgeKind
}): Promise<boolean> {
  if (!opts.contactId) return false

  try {
    const { data: contact } = await db
      .from("contacts")
      .select("language")
      .eq("id", opts.contactId)
      .maybeSingle()
    const locale = localeFromLanguage(contact?.language)

    const { error } = await db.from("portal_messages").insert({
      account_id: opts.accountId ?? null,
      contact_id: opts.contactId,
      sender_type: "admin",
      sender_id: ADMIN_SENDER_ID,
      message: buildBody(opts.kind, opts.documentName || "Document", locale),
      topic: TOPIC[locale],
      attachments: [],
    })
    if (error) {
      console.error(`[esign-chat-nudge] could not post to the portal chat: ${error.message}`)
      return false
    }
    return true
  } catch (err) {
    console.error("[esign-chat-nudge] failed:", err instanceof Error ? err.message : err)
    return false
  }
}
