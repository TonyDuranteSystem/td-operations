import { supabaseAdmin } from '@/lib/supabase-admin'
import { IntakeTable } from './components/intake-table'

// ─── Types ──────────────────────────────────────────────────

interface ParsedIntake {
  name: string
  email: string
  phone: string | null
  call_date: string | null
  reason: string | null
  referrer_name: string | null
  event_uri: string | null
  event_type_name: string | null
}

interface IntakeMatches {
  existing_lead_id: string | null
  existing_lead_status: string | null
  existing_contact_id: string | null
  existing_contact_name: string | null
}

export interface CirclebackMatch {
  id: string
  meeting_name: string
  duration_seconds: number | null
  created_at: string
}

export interface IntakeEntry {
  id: string
  created_at: string
  review_status: string
  parsed: ParsedIntake
  matches: IntakeMatches
  circleback_match: CirclebackMatch | null
}

// ─── Legacy payload extractor ───────────────────────────────
// Handles webhook_events that were logged before the enriched format

function extractLegacyParsed(payload: unknown): ParsedIntake {
  const p = payload as Record<string, unknown> | null
  const calendlyPayload = p?.payload as Record<string, unknown> | undefined
  const invitee = calendlyPayload?.invitee as Record<string, unknown> | undefined
  const scheduledEvent = calendlyPayload?.scheduled_event as Record<string, unknown> | undefined

  return {
    name: (invitee?.name as string) || (invitee?.email as string)?.split('@')[0] || 'Unknown',
    email: ((invitee?.email as string) || '').toLowerCase().trim(),
    phone: (invitee?.phone_number as string) || null,
    call_date: (scheduledEvent?.start_time as string)?.split('T')[0] || null,
    reason: null,
    referrer_name: null,
    event_uri: (calendlyPayload?.event as string) || null,
    event_type_name: (scheduledEvent?.name as string) || null,
  }
}

// ─── Page ───────────────────────────────────────────────────

export default async function IntakePage() {
  // Fetch pending + recently processed Calendly entries
  const [pendingResult, processedResult] = await Promise.all([
    supabaseAdmin
      .from('webhook_events')
      .select('id, payload, review_status, created_at')
      .eq('source', 'calendly')
      .eq('event_type', 'invitee.created')
      .in('review_status', ['pending_review', 'auto_linked'])
      .order('created_at', { ascending: false })
      .limit(50),
    supabaseAdmin
      .from('webhook_events')
      .select('id, payload, review_status, created_at')
      .eq('source', 'calendly')
      .eq('event_type', 'invitee.created')
      .in('review_status', ['converted', 'linked', 'lost', 'dismissed'])
      .order('created_at', { ascending: false })
      .limit(20),
  ])

  const allEvents = [...(pendingResult.data || []), ...(processedResult.data || [])]

  // Fetch recent Circleback calls for auto-matching
  const { data: recentCalls } = await supabaseAdmin
    .from('call_summaries')
    .select('id, meeting_name, duration_seconds, attendees, created_at')
    .order('created_at', { ascending: false })
    .limit(200)

  // Build email -> call lookup (exclude Antonio's own email)
  const emailCallMap = new Map<string, CirclebackMatch>()
  for (const call of recentCalls || []) {
    const attendees = call.attendees as Array<{ name?: string; email?: string }> | null
    if (!Array.isArray(attendees)) continue
    for (const att of attendees) {
      if (att.email && !att.email.includes('tonydurante')) {
        const key = att.email.toLowerCase()
        // Keep the most recent call per email
        if (!emailCallMap.has(key)) {
          emailCallMap.set(key, {
            id: call.id,
            meeting_name: call.meeting_name,
            duration_seconds: call.duration_seconds,
            created_at: call.created_at,
          })
        }
      }
    }
  }

  // Build intake entries with Circleback auto-match
  const entries: IntakeEntry[] = allEvents.map(evt => {
    const payload = evt.payload as { parsed?: ParsedIntake; matches?: IntakeMatches } | null
    const parsed = payload?.parsed || extractLegacyParsed(evt.payload)
    const matches = payload?.matches || {
      existing_lead_id: null,
      existing_lead_status: null,
      existing_contact_id: null,
      existing_contact_name: null,
    }

    const circleback_match = parsed.email
      ? emailCallMap.get(parsed.email.toLowerCase()) || null
      : null

    return {
      id: evt.id,
      created_at: evt.created_at,
      review_status: evt.review_status,
      parsed,
      matches,
      circleback_match,
    }
  })

  const pendingEntries = entries.filter(e => ['pending_review', 'auto_linked'].includes(e.review_status))
  const processedEntries = entries.filter(e => !['pending_review', 'auto_linked'].includes(e.review_status))

  return (
    <div className="p-6 lg:p-8 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Intake Review</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Calendly bookings staged for review. Create leads, link to existing, or dismiss.
        </p>
      </div>

      {pendingEntries.length === 0 && processedEntries.length === 0 ? (
        <div className="bg-white rounded-lg border p-8 text-center">
          <p className="text-muted-foreground">No intake entries yet.</p>
          <p className="text-xs text-muted-foreground mt-1">
            New Calendly bookings will appear here for review.
          </p>
        </div>
      ) : (
        <>
          {pendingEntries.length > 0 && (
            <div className="mb-8">
              <h2 className="text-sm font-semibold text-zinc-700 mb-3">
                Pending Review ({pendingEntries.length})
              </h2>
              <IntakeTable entries={pendingEntries} />
            </div>
          )}

          {processedEntries.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-zinc-400 mb-3">
                Recently Processed ({processedEntries.length})
              </h2>
              <IntakeTable entries={processedEntries} readonly />
            </div>
          )}
        </>
      )}
    </div>
  )
}
