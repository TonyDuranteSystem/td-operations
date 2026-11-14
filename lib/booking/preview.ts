/**
 * Booking page — "When it gets booked, the system will:" the plain-English preview under the link maker. PURE.
 * It is written FROM the decision the link will really carry (decideLinkPlan's result), so the preview can never promise something the engine does not do:
 * the words come from Antonio's approved mockup, and a line is kept only where the engine (Stage 1a) really does it.
 * Nothing about money or a referrer: those belong to Stage 3 and Stage 2 and are not offered on the page yet.
 */

import { STANDARD_MINUTES, type LinkPlan, type PersonState } from "@/lib/booking/plan"

export interface PreviewLine {
  label: string
  text: string
}

export interface PreviewInput {
  plan: LinkPlan
  personState: PersonState
  /** the person's name, or null for someone new with no name typed */
  personName: string | null
  /** does the link carry at least one email to check the booker against? */
  hasEmails: boolean
}

export function lengthText(minutes: number): string {
  if (minutes === 60) return "1 hour"
  if (minutes === 120) return "2 hours"
  return `${minutes} minutes`
}

const possessive = (name: string): string => (/s$/i.test(name) ? `${name}'` : `${name}'s`)

export function describePlan(input: PreviewInput): PreviewLine[] {
  const { plan, personState, hasEmails } = input
  const name = (input.personName ?? "").trim()
  const nm = name || "the person"
  const label = plan.snapshot.kind_label
  const lines: PreviewLine[] = []

  lines.push({
    label: "Call",
    text: `A Zoom call, ${lengthText(plan.minutes)}. ${plan.template === "sales" ? "The person answers your sales questions first." : "No sales questions."}`,
  })

  if (plan.recorder === "none") {
    lines.push({ label: "Page", text: "Only on your calendar. No page is created or changed." })
    lines.push({ label: "Record", text: "Nothing is created." })
    lines.push({ label: "Recording", text: "Still transcribed and filed with your other Zoom calls. Nothing links it to a person." })
  } else if (plan.recorder === "attach") {
    lines.push({ label: "Page", text: `The call is saved on ${possessive(nm)} contact page, under Calls, and shows on your calendar.` })
    lines.push({ label: "Record", text: "No lead is created. The booking is kept on the contact, so nothing is lost." })
    lines.push({ label: "Recording", text: "Linked to the same contact page." })
  } else if (personState === "lead") {
    lines.push({ label: "Page", text: `The booking is added to ${possessive(nm)} lead and shows on your calendar.` })
    lines.push({ label: "Record", text: "No duplicate lead is made. Same as today." })
    lines.push({ label: "Recording", text: "Linked by email, as today." })
  } else if (personState === "contact") {
    // a kind that treats an existing contact "as today": the booking becomes a lead tagged as an existing client's call
    lines.push({ label: "Page", text: "The booking becomes a lead, as today, tagged as an existing client's call, and shows on your calendar." })
    lines.push({ label: "Record", text: "Same as today: the lead is made by the booking itself." })
    lines.push({ label: "Recording", text: "Linked by email, as today." })
  } else {
    const marked = plan.rule.mark_lead ? `, marked ${label}` : ""
    lines.push({ label: "Page", text: `A new lead appears in Leads${marked}, and on your calendar.` })
    lines.push({ label: "Record", text: plan.rule.mark_lead ? `A new lead is created, marked ${label}. No new kind of record is added.` : "A new lead is created, as it is today." })
    lines.push({ label: "Recording", text: "Linked by email, as today." })
  }

  if (plan.minutes !== STANDARD_MINUTES) {
    lines.push({ label: "Length", text: "Any length other than 30 minutes is made as a one-time Calendly link, so it can only be used once." })
  } else if (plan.once) {
    lines.push({ label: "Use", text: "Attached to the first booking only. A later booking on this link is saved as usual and a card asks you." })
  } else {
    lines.push({ label: "Use", text: "The link stays open: every booking on it is attached the same way." })
  }

  lines.push(
    hasEmails
      ? { label: "If it differs", text: "If a different email books, the booking is saved as usual and a card asks you. It is never dropped." }
      : { label: "If it differs", text: plan.once ? "There is no email to compare with, so whoever books first takes the link." : "There is no email to compare with, so every booking on this link is treated the same way." },
  )
  return lines
}
