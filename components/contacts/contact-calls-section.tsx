/**
 * WS-D (dev job c0a61e44): every Circleback call for a person, on the contact
 * page. Covers calls linked directly to the contact (post-conversion, written
 * by the upgraded webhook) AND calls linked to their pre-conversion lead(s)
 * via leads.converted_to_contact_id — before this, a call with an existing
 * client surfaced nowhere. Server component; renders nothing when empty.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

interface CallRow {
  id: string
  meeting_name: string | null
  duration_seconds: number | null
  recording_url: string | null
  created_at: string | null
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
    .select("id, meeting_name, duration_seconds, recording_url, created_at")
    .or(ors.join(","))
    .order("created_at", { ascending: false })
    .limit(25)

  const calls = (data ?? []) as CallRow[]
  if (calls.length === 0) return null

  return (
    <div className="bg-white rounded-lg border p-5 mb-4">
      <h3 className="text-sm font-semibold mb-3">Calls ({calls.length})</h3>
      <ul className="space-y-2">
        {calls.map((c) => (
          <li
            key={c.id}
            className="flex items-center justify-between gap-3 text-sm border-b last:border-b-0 pb-2"
          >
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
          </li>
        ))}
      </ul>
    </div>
  )
}
