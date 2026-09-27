import { supabaseAdmin } from "@/lib/supabase-admin"
import { reportSystemError } from "@/lib/system-errors"
import { getServiceBySlugStatic } from "@/lib/services"
import { findAuthUsersByContactId } from "@/lib/auth-admin-helpers"
import { resolvePrimaryContact } from "@/lib/members/resolve-primary-contact"
import { getPendingClosuresOrNull } from "./pending-closures"
import { notifyClientActionRequired, type ActionRequiredResult } from "./action-required"

/**
 * Tell the client to fill in the closure form for a Company Closure that STAFF
 * opened by hand (Antonio, 2026-09-24 — dev job e2fee7e7, the Milan case).
 *
 * A closure bought in a contract is announced by the payment welcome message;
 * a closure staff add from the CRM was silent — the only trace was the card on
 * the portal home, which the client may never open. This sends ONE chat message
 * + bell + email (via notifyClientActionRequired) pointing at that card's form.
 *
 * It never posts to What's New: that feed is for things the CLIENT did. The
 * client's own submission later lights the purple dot (closure-form-completed).
 *
 * Gates — the message only goes out when all hold; otherwise a plain reason is
 * returned so the staff member sees why in the toast:
 *  - the service is an active Company Closure;
 *  - there is a person to tell (the SD's contact, or for a company-only SD the
 *    company's primary contact, who must be linked to that company);
 *  - that person has a portal login (the message points into the portal);
 *  - the form for THIS closure is still owed (same check as the home card);
 *  - no finished closure form is already on file that this might duplicate:
 *    for a company closure, a finished form for that company → not sent
 *    (the SD is probably a duplicate); for a closure of a company we don't
 *    track (no company record), an older finished form of this person's →
 *    HELD, because it may be the same company — staff can "Send anyway".
 */

const CLOSURE_SERVICE_TYPE = getServiceBySlugStatic("closure")?.display_name ?? "Company Closure"
const DONE_STATUSES = ["completed", "reviewed"]
const RECENT_WINDOW_MS = 10 * 60 * 1000

export type ClosurePromptStatus = "sent" | "held" | "skipped" | "failed"

export interface ClosurePromptOutcome {
  status: ClosurePromptStatus
  /** Plain-English line for the staff toast / MCP result. */
  reason: string
  /** True only for the "older form on file" hold — the UI offers Send anyway. */
  canForce?: boolean
  channels?: Pick<ActionRequiredResult, "chat" | "notification" | "email">
}

/** Pure: build the client-facing copy (exported for tests). */
export function buildClosurePromptCopy(companyName: string | null) {
  const en = companyName ?? "your previous company"
  const it = companyName ?? "la tua società precedente"
  return {
    title: {
      en: companyName ? `Company closure form — ${companyName}` : "Company closure form",
      it: companyName ? `Modulo di chiusura società — ${companyName}` : "Modulo di chiusura società",
    },
    message: {
      en: `We have opened the closure of ${en}. To go ahead we need a few details from you: please fill in the closure form. You will also find it on your portal home page, under "Complete Registration — Company Closure".`,
      it: `Abbiamo avviato la chiusura di ${it}. Per procedere ci servono alcuni dati: compila il modulo di chiusura. Lo trovi anche nella home del tuo portale, nel riquadro "Completa Registrazione — Chiusura Società".`,
    },
    ctaLabel: { en: "Fill in the form", it: "Compila il modulo" },
  }
}

/** Pure: turn the per-channel results into one outcome (exported for tests). */
export function interpretPromptResult(r: ActionRequiredResult, recipientName: string): ClosurePromptOutcome {
  const channels = { chat: r.chat, notification: r.notification, email: r.email }
  if (!r.dispatched) {
    const why = r.chat.replace(/^skipped:\s*/, "")
    if (/duplicate/.test(why)) {
      return { status: "skipped", reason: `Already sent to ${recipientName} a few minutes ago — not sent twice.`, channels }
    }
    return { status: "failed", reason: `Message to ${recipientName} not sent: ${why}.`, channels }
  }
  const bad = [r.chat, r.notification, r.email].filter((c) => /^(failed|partial)/.test(c))
  const reached = r.chat === "ok" || /^ok/.test(r.email)
  if (!reached) {
    return { status: "failed", reason: `Message to ${recipientName} could not be delivered (${bad.join("; ")}).`, channels }
  }
  if (bad.length) {
    return { status: "sent", reason: `Sent to ${recipientName}, but one channel failed (${bad.join("; ")}).`, channels }
  }
  const via = /^ok/.test(r.email) ? "portal chat, bell and email" : "portal chat and bell — no email sent: " + r.email.replace(/^skipped:\s*/, "")
  return { status: "sent", reason: `${recipientName} was asked to fill in the closure form (${via}).`, channels }
}

function formatDate(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "an earlier date"
}

export async function promptClientForClosureForm(opts: {
  serviceDeliveryId: string
  /** Send even though an older finished form of this person's is on file. */
  force?: boolean
}): Promise<ClosurePromptOutcome> {
  const { serviceDeliveryId } = opts
  try {
    const { data: sd, error: sdErr } = await supabaseAdmin
      .from("service_deliveries")
      .select("id, service_type, status, contact_id, account_id")
      .eq("id", serviceDeliveryId)
      .maybeSingle()
    if (sdErr || !sd) {
      return report(serviceDeliveryId, `closure lookup failed: ${sdErr?.message ?? "service not found"}`)
    }
    if (sd.service_type !== CLOSURE_SERVICE_TYPE) {
      return { status: "skipped", reason: "Not a Company Closure — no client message needed." }
    }
    if (sd.status !== "active") {
      return { status: "skipped", reason: "The closure is not active — no client message sent." }
    }

    // ── Who to tell ────────────────────────────────────────────────────
    let contactId: string | null = sd.contact_id ?? null
    let recipientName = "the client"
    if (!contactId && sd.account_id) {
      const primary = await resolvePrimaryContact(sd.account_id)
      if (primary.outcome !== "resolved") {
        return { status: "skipped", reason: "No primary contact found for this company — client not messaged." }
      }
      contactId = primary.contact.id
    }
    if (!contactId) {
      return { status: "skipped", reason: "The closure has no client attached — nobody to message." }
    }
    if (sd.account_id) {
      // The owed-form check (and the portal card) only see company closures of
      // companies this person is LINKED to — an unlinked person would get a
      // message pointing at a card they cannot see.
      const { data: link } = await supabaseAdmin
        .from("account_contacts")
        .select("contact_id")
        .eq("account_id", sd.account_id)
        .eq("contact_id", contactId)
        .maybeSingle()
      if (!link) {
        return { status: "skipped", reason: "The client on this closure is not linked to the company being closed — not messaged. Link them to the company first." }
      }
    }
    const { data: contact } = await supabaseAdmin
      .from("contacts")
      .select("full_name")
      .eq("id", contactId)
      .maybeSingle()
    recipientName = contact?.full_name || recipientName

    // ── Portal login ───────────────────────────────────────────────────
    const logins = await findAuthUsersByContactId(contactId)
    if (logins.length === 0) {
      return { status: "skipped", reason: `${recipientName} has no portal login yet — not messaged (the form lives in the portal).` }
    }

    // ── Is the form for THIS closure still owed? ───────────────────────
    const pending = await getPendingClosuresOrNull(contactId)
    if (pending === null) {
      return report(serviceDeliveryId, "could not check whether the closure form is still owed", contactId)
    }
    const mine = pending.find((p) => p.serviceDeliveryId === sd.id)
    if (!mine) {
      return { status: "skipped", reason: `The closure form for this service is already on file — ${recipientName} not messaged.` }
    }

    // ── Just sent for this closure? (backstop to the bell-based dedup, which
    //    misses when the bell insert failed) ─────────────────────────────
    const { count: recentForSd } = await supabaseAdmin
      .from("portal_messages")
      .select("id", { count: "exact", head: true })
      .eq("service_delivery_id", sd.id)
      .eq("sender_type", "admin")
      .gt("created_at", new Date(Date.now() - RECENT_WINDOW_MS).toISOString())
    if (recentForSd && recentForSd > 0) {
      return { status: "skipped", reason: `A message about this closure was sent a few minutes ago — not sent twice.` }
    }

    // ── Another open closure in the same scope → probably a duplicate ──
    let siblingQuery = supabaseAdmin
      .from("service_deliveries")
      .select("id")
      .eq("service_type", CLOSURE_SERVICE_TYPE)
      .eq("status", "active")
      .neq("id", sd.id)
      .limit(1)
    siblingQuery = sd.account_id
      ? siblingQuery.eq("account_id", sd.account_id)
      : siblingQuery.is("account_id", null).eq("contact_id", contactId)
    const { data: siblings } = await siblingQuery
    if (siblings && siblings.length) {
      if (sd.account_id) {
        return { status: "skipped", reason: "This company already has another open Company Closure — not sent (this one is probably a duplicate)." }
      }
      if (!opts.force) {
        return {
          status: "held",
          canForce: true,
          reason: `Not sent yet: ${recipientName} already has another open Company Closure. If this one is for a different company, use "Send anyway".`,
        }
      }
    }

    // ── A finished form already on file that this might duplicate? ─────
    if (sd.account_id) {
      const { data: done } = await supabaseAdmin
        .from("closure_submissions")
        .select("completed_at, created_at")
        .eq("account_id", sd.account_id)
        .in("status", DONE_STATUSES)
        .order("created_at", { ascending: false })
        .limit(1)
      if (done && done.length) {
        return {
          status: "skipped",
          reason: `A closure form for this company is already on file (${formatDate(done[0].completed_at ?? done[0].created_at)}) — not sent. This closure may be a duplicate; the portal card still shows until it is resolved.`,
        }
      }
    }
    // An older finished form of this person's with NO company attached (legacy
    // emailed link / contact-only) may be this very company — hold, don't
    // re-ask (the DoctorGut re-submission pattern).
    if (!opts.force) {
      const { data: done } = await supabaseAdmin
        .from("closure_submissions")
        .select("completed_at, created_at, submitted_data")
        .eq("contact_id", contactId)
        .is("account_id", null)
        .in("status", DONE_STATUSES)
        .order("created_at", { ascending: false })
        .limit(1)
      if (done && done.length) {
        const prev = done[0]
        const llcName = (prev.submitted_data as { llc_name?: unknown } | null)?.llc_name
        const which = typeof llcName === "string" && llcName.trim() ? ` for ${llcName.trim()}` : ""
        return {
          status: "held",
          canForce: true,
          reason: `Not sent yet: ${recipientName} already sent a closure form${which} on ${formatDate(prev.completed_at ?? prev.created_at)}. If this closure is for a different company, use "Send anyway".`,
        }
      }
    }

    const copy = buildClosurePromptCopy(mine.companyName)
    const result = await notifyClientActionRequired({
      contact_id: contactId,
      account_id: sd.account_id ?? null,
      service_delivery_id: sd.id,
      title: copy.title,
      message: copy.message,
      ctaLabel: copy.ctaLabel,
      // Per-closure link (two closures back-to-back are not deduped into one);
      // the same destination as the home-page closure card.
      link: `/portal/wizard?type=closure&sd=${encodeURIComponent(sd.id)}`,
    })
    const outcome = interpretPromptResult(result, recipientName)
    if (outcome.status === "failed" || /one channel failed/.test(outcome.reason)) {
      reportSystemError({
        source: "server",
        route: "lib/portal/closure-client-prompt",
        message: `closure form prompt: ${outcome.reason}`,
        context: { serviceDeliveryId, contactId, channels: outcome.channels },
      }).catch(() => {})
    }
    return outcome
  } catch (err) {
    return report(serviceDeliveryId, err instanceof Error ? err.message : String(err))
  }
}

function report(serviceDeliveryId: string, detail: string, contactId?: string): ClosurePromptOutcome {
  reportSystemError({
    source: "server",
    route: "lib/portal/closure-client-prompt",
    message: `closure form prompt failed: ${detail}`,
    context: { serviceDeliveryId, contactId: contactId ?? null },
  }).catch(() => {})
  return { status: "failed", reason: `Client not messaged — ${detail}.` }
}
