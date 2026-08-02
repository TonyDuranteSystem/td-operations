/**
 * Inbox worker "send a PORTAL CHAT message" — freeze for a human Confirm.
 *
 * Antonio, 2026-07-31: from the Inbox, the staff member DISCUSSES the wording with
 * the worker while reading an email, then asks it to send that agreed message to the
 * client — through the same Confirm card the email path already uses.
 *
 * Separate file from worker-email-send.ts on purpose: that module is the EMAIL
 * dispatcher (its own doc comment says so, and its confirm function is named for it).
 * A portal branch buried inside a file named for email is what the next session would
 * fail to find. The two share the same table and the same lifecycle helpers — supersede,
 * the per-turn pairing snapshot, the single-use claim — which is exactly why they must
 * share one table rather than a sibling: those are set operations over "this actor's
 * pending drafts on this conversation", and splitting the table would need a
 * distributed transaction to keep them honest.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { supersedeEarlierDrafts, type PrepareResult } from "@/lib/inbox/worker-email-send"

export interface PreparePortalInput {
  threadUuid: string
  /** The agreed message, verbatim. Sent exactly as frozen — never re-drafted at send. */
  message: string
  /**
   * The client the WORKER suggests, if it can tell from the email. A SUGGESTION only:
   * it must render on the card as something the staff member has to click, never as a
   * pre-selected value — a pre-fill makes Confirm a one-click send to a name nobody
   * chose, which is the whole risk of a screen where the client is not fixed.
   */
  proposedAccountId?: string | null
  proposedContactId?: string | null
  /** "en" | "it" — the language the message is written in, per the card's dropdown. */
  locale: string
  actor: string
}

/**
 * Freeze a portal-chat message. Does NOT send. The human's Confirm click is the gate.
 */
export async function preparePortalSend(input: PreparePortalInput): Promise<PrepareResult> {
  const message = input.message?.trim()
  if (!message) {
    return { ok: false, message: "❌ There's no message to send — tell me what you'd like to say to the client." }
  }

  // The database refuses mailbox/to_address/subject on a portal row, so there is no
  // way for this payload to be dispatched down the Gmail path even if a future branch
  // is reordered. Nothing here supplies them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from("worker_prepared_sends")
    .insert({
      thread_uuid: input.threadUuid,
      kind: "portal",
      body: message,
      proposed_account_id: input.proposedAccountId ?? null,
      proposed_contact_id: input.proposedContactId ?? null,
      draft_locale: input.locale,
      attachments: [],
      actor: input.actor,
      status: "pending",
    })
    .select("id")
    .single()
  if (error || !data) {
    console.error("[worker-portal-send] prepare insert failed:", error)
    return { ok: false, message: "❌ Couldn't prepare the message — please try again." }
  }

  await supersedeEarlierDrafts({ threadUuid: input.threadUuid, actor: input.actor, kind: "portal", keepId: data.id })

  return {
    ok: true,
    preparedId: data.id,
    // Deliberately does NOT restate the message. The card carries the exact text that
    // will be sent; repeating it in the reply puts two versions on screen and invites
    // the staff member to approve the one they read rather than the one that ships.
    message:
      "Ready. The Confirm card is below — choose the client, check the language, and press Confirm. I won't send it on my own, and Confirm sends exactly the message on the card.",
  }
}


/* ------------------------------------------------------------------------- *
 * CONFIRM — the staff member's click is what delivers.
 * ------------------------------------------------------------------------- */

export type ConfirmPortalResult =
  | { ok: true; cancelled: true }
  | { ok: true; sent: true; recipientName: string; notified: "emailed" | "not_emailed" | "unknown" }
  | { ok: false; reason: string; status?: number }

/**
 * Deliver a frozen portal message after an explicit Confirm.
 *
 * THE RECIPIENT ARRIVES NOW, FROM THE BROWSER, and that is the whole reason this
 * function is careful. On the email path the recipient was frozen at draft time and
 * the click only approves it. Here the human picks the client ON the card, so the id
 * is untrusted input on a client-facing send: it is re-resolved and re-validated
 * against the database before anything is written, and the proposal the worker made
 * is never read back — a suggestion must not be able to become an authorisation.
 */
export async function confirmPortalSend(input: {
  preparedId: string
  actorEmail: string
  rowActor: string
  accountId: string | null
  contactId: string | null
  action: "confirm" | "cancel"
}): Promise<ConfirmPortalResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any

  if (input.action === "cancel") {
    await db
      .from("worker_prepared_sends")
      .update({ status: "cancelled", resolved_at: new Date().toISOString() })
      .eq("id", input.preparedId)
      .eq("status", "pending")
    return { ok: true, cancelled: true }
  }

  // WHO MAY CONFIRM. On the email path this barely matters — the recipient is frozen,
  // so a colleague confirming sends the same email to the same address. Here the
  // confirmer supplies the recipient, so an unbound id would be a "deliver this text
  // to any client of my choosing" primitive keyed by a uuid — and in Team Chat that
  // uuid is persisted into a message anyone in the channel can see.
  //
  // Actors are namespaced per surface (`crm-inbox:<email>`, `crm-portal:<email>`,
  // `crm-sidebar:<email or id>`, `team-chat:<display name>`), so compare on the part
  // after the prefix and accept only an exact email match. A portal freeze can only
  // originate on the Inbox surface today, so this is strict on purpose.
  const rowEmail = input.rowActor.includes(":") ? input.rowActor.slice(input.rowActor.indexOf(":") + 1) : input.rowActor
  if (rowEmail.toLowerCase() !== input.actorEmail.toLowerCase()) {
    return {
      ok: false,
      status: 403,
      reason: "This message was prepared by someone else. Ask them to send it, or ask the assistant to prepare it again for you.",
    }
  }

  if (!input.accountId && !input.contactId) {
    return { ok: false, reason: "Choose which client this goes to before sending." }
  }
  if (input.accountId && input.contactId) {
    // The card offers ONE target. Both set means the caller is confused about the
    // routing, and routing is exactly what Antonio pinned down: a company message is
    // seen by every member, a person's message lands in their personal chat. Guessing
    // between them here would silently pick one.
    return { ok: false, reason: "Pick either the company or one person, not both." }
  }

  // RE-VALIDATE against the database. The id came through a browser.
  let recipientName = ""
  if (input.accountId) {
    const { data: acct } = await db.from("accounts").select("id, company_name").eq("id", input.accountId).maybeSingle()
    if (!acct) return { ok: false, reason: "That company no longer exists — pick the client again." }
    recipientName = acct.company_name ?? "this company"
  } else {
    const { data: contact } = await db.from("contacts").select("id, full_name").eq("id", input.contactId).maybeSingle()
    if (!contact) return { ok: false, reason: "That person no longer exists — pick the client again." }
    recipientName = contact.full_name ?? "this person"
  }

  // Claim the row: pending → sent in one guarded update. This, not the content-hash
  // dedup downstream, is the double-send guard — the cross-run idempotency claim is a
  // no-op here because a confirm click carries no originating message id.
  const { data: claimed } = await db
    .from("worker_prepared_sends")
    .update({
      status: "sent",
      resolved_at: new Date().toISOString(),
      // The audit record of WHO WAS ACTUALLY MESSAGED — the human's pick, never the
      // worker's proposal, and written only now that it has been validated.
      portal_account_id: input.accountId,
      portal_contact_id: input.contactId,
    })
    .eq("id", input.preparedId)
    .eq("status", "pending")
    .select("*")
    .single()
  if (!claimed) return { ok: false, status: 409, reason: "This message was already sent or cancelled." }

  // STALENESS. The email path enforces this inside its own dispatcher, so a portal
  // send inherits nothing — it has to be checked here or a card left open all morning
  // would deliver news the client has long since had. Nothing has been sent yet.
  const { PREPARED_SEND_TTL_MS } = await import("@/lib/inbox/worker-email-send")
  if (claimed.created_at && Date.now() - new Date(claimed.created_at).getTime() > PREPARED_SEND_TTL_MS) {
    await db
      .from("worker_prepared_sends")
      .update({ status: "cancelled", resolved_at: new Date().toISOString() })
      .eq("id", input.preparedId)
    return { ok: false, reason: "This draft is too old to send — ask the assistant to prepare it again." }
  }

  const { sendPortalMessageFromWorker } = await import("@/lib/ai-agent/worker-tools")
  const outcome = await sendPortalMessageFromWorker(
    {
      account_id: input.accountId ?? undefined,
      contact_id: input.contactId ?? undefined,
      message: claimed.body,
      // Antonio's ruling: the pick goes through untouched. A company stays a company.
      exact_recipient: true,
    },
    input.actorEmail,
    null,
  )

  // That helper reports failure as a STRING rather than throwing, which is how its
  // errors have been discarded before. Anything that is not a real delivery must roll
  // the row back so the staff member can retry — including the "✅ Already sent"
  // duplicate-window return, which reads like success and posts nothing.
  const delivered = outcome.startsWith("✅") && !outcome.includes("Already sent")
  if (!delivered) {
    await db
      .from("worker_prepared_sends")
      .update({ status: "pending", resolved_at: null, portal_account_id: null, portal_contact_id: null })
      .eq("id", input.preparedId)
      .eq("status", "sent")
    return {
      ok: false,
      reason: outcome.startsWith("✅")
        ? "That exact message was already sent to this client moments ago, so nothing new was posted."
        : outcome.replace(/^❌\s*/, "") || "The message could not be sent — please try again.",
    }
  }

  // WHETHER THE CLIENT WAS EMAILED IS NOT KNOWABLE HERE, and pretending otherwise is
  // worse than staying quiet.
  //
  // This used to test `outcome.includes("notified")`. The real success string is
  // "✅ Portal message sent to <name>. id=… at …" — the word never appears, so it
  // reported "no email went out" on EVERY send, and staff would chase a client by
  // Gmail about a message the client had already been emailed about.
  //
  // The unit test passed because its mock returned a fabricated string containing
  // "notified" that production cannot produce. A green test proving nothing.
  //
  // Underneath the wording bug is a real one: notifyClientOfAdminMessage is
  // fire-and-forget inside sendPortalMessageFromWorker, so its outcome is genuinely
  // unavailable on this path. Wiring it back would mean changing that helper, which
  // four other surfaces depend on. Until then the honest answer is "unknown" — and the
  // panel says the message is in the portal without asserting anything about email.
  return { ok: true, sent: true, recipientName, notified: "unknown" }
}
