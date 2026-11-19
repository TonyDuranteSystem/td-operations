/**
 * WS-D (dev job c0a61e44): every Circleback call for a person, on the contact
 * page. Covers calls linked directly to the contact (post-conversion, written
 * by the upgraded webhook) AND calls linked to their pre-conversion lead(s)
 * via leads.converted_to_contact_id — before this, a call with an existing
 * client surfaced nowhere. Server component; renders nothing when empty.
 *
 * Notes/action items added (dev job 93580372, follow-up to the existing-client
 * lead fix): previously this list showed only meeting name/date/duration/
 * recording link — the actual summary of what was discussed was only ever
 * shown on the pre-conversion lead page, so once someone became a client that
 * detail effectively disappeared from view (still saved, just not displayed).
 * Same truncation convention as app/(dashboard)/leads/[id]/components/call-summary-card.tsx
 * (notes clamped, action items capped) but tighter, since this list can show
 * many calls at once rather than one.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { todayInNewYork } from "@/lib/leads/list-filters"
import { listContactCalls, bookedCallsToShow, contactCallChip } from "@/lib/leads/contact-calls"

interface CallRow {
  id: string
  meeting_name: string | null
  duration_seconds: number | null
  recording_url: string | null
  created_at: string | null
  notes: string | null
  action_items: unknown[] | null
}

const NOTES_PREVIEW_CHARS = 240
const MAX_ACTION_ITEMS = 3

function actionItemText(item: unknown): string {
  if (typeof item === "string") return item
  const rec = item as Record<string, string> | null
  return rec?.text || rec?.description || JSON.stringify(item)
}

export async function ContactCallsSection({ contactId }: { contactId: string }) {
  const { data: leadRows } = await supabaseAdmin
    .from("leads")
    .select("id")
    .eq("converted_to_contact_id", contactId)
  const leadIds = (leadRows ?? []).map((l) => (l as { id: string }).id)

  const ors = [`contact_id.eq.${contactId}`]
  if (leadIds.length) ors.push(`lead_id.in.(${leadIds.join(",")})`)

  const { data } = await supabaseAdmin
    .from("call_summaries")
    .select("id, meeting_name, duration_seconds, recording_url, created_at, notes, action_items")
    .or(ors.join(","))
    .order("created_at", { ascending: false })
    .limit(25)

  const calls = (data ?? []) as CallRow[]

  // Calls booked through a made booking link by someone who is already a contact (no lead exists, so they have no other home). Tolerant: a missing table or a
  // read error is "none". A booked call disappears from this list once a call summary exists for the same New York day (the summary above already shows it).
  const booked = bookedCallsToShow(await listContactCalls(supabaseAdmin, contactId), calls.map((c) => c.created_at).filter((d): d is string => !!d))

  if (calls.length === 0 && booked.length === 0) return null
  const todayNy = todayInNewYork(new Date())

  return (
    <>
    {booked.length > 0 && (
      <div className="bg-white rounded-lg border p-5 mb-4">
        <h3 className="text-sm font-semibold mb-3">Booked calls ({booked.length})</h3>
        <ul className="space-y-2">
          {booked.map((b) => (
            <li key={b.id} className="text-sm flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium truncate">{b.event_type_name || "Call"}</div>
                <div className="text-xs text-muted-foreground">
                  {b.scheduled_start ? `${new Date(b.scheduled_start).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" })} ET` : "Time not known"}
                </div>
              </div>
              <span className="text-xs rounded-full border px-2 py-0.5 shrink-0">{contactCallChip(b, todayNy)}</span>
            </li>
          ))}
        </ul>
      </div>
    )}
    {calls.length > 0 && (
    <div className="bg-white rounded-lg border p-5 mb-4">
      <h3 className="text-sm font-semibold mb-3">Calls ({calls.length})</h3>
      <ul className="space-y-3">
        {calls.map((c) => {
          const noteText = typeof c.notes === "string" ? c.notes : ""
          const actionItems = Array.isArray(c.action_items) ? c.action_items : []
          return (
            <li key={c.id} className="text-sm border-b last:border-b-0 pb-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium truncate">{c.meeting_name || "Call"}</div>
                  <div className="text-xs text-muted-foreground">
                    {c.created_at ? new Date(c.created_at).toLocaleString() : ""}
                    {c.duration_seconds ? ` · ${Math.round(c.duration_seconds / 60)} min` : ""}
                  </div>
                </div>
                {c.recording_url && (
                  <a
                    href={c.recording_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-blue-600 hover:underline shrink-0"
                  >
                    Recording
                  </a>
                )}
              </div>

              {noteText && (
                <p className="mt-1.5 text-xs text-zinc-700 whitespace-pre-wrap line-clamp-3">
                  {noteText.slice(0, NOTES_PREVIEW_CHARS)}
                  {noteText.length > NOTES_PREVIEW_CHARS ? "…" : ""}
                </p>
              )}

              {actionItems.length > 0 && (
                <ul className="mt-1.5 space-y-0.5">
                  {actionItems.slice(0, MAX_ACTION_ITEMS).map((item, i) => (
                    <li key={i} className="text-xs text-zinc-700 flex items-start gap-1.5">
                      <span className="text-zinc-400 mt-0.5">-</span>
                      <span>{actionItemText(item)}</span>
                    </li>
                  ))}
                  {actionItems.length > MAX_ACTION_ITEMS && (
                    <li className="text-xs text-muted-foreground">
                      +{actionItems.length - MAX_ACTION_ITEMS} more
                    </li>
                  )}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
    </div>
    )}
    </>
  )
}
