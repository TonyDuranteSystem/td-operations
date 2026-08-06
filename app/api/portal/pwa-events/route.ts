/**
 * POST /api/portal/pwa-events — public install-funnel event sink.
 * (Phase 2 of install adoption, dev job 8f38add1.)
 *
 * Public by necessity: the install page is visited by logged-OUT phones, so
 * this path is in middleware PUBLIC_PREFIXES (like /api/referral/track).
 * Council rules enforced HERE, server-side:
 *  - service-role-only writes (table has RLS + zero policies; anon key is
 *    powerless even with the URL);
 *  - strict enum validation via parsePwaEventPayload — unknown fields,
 *    unknown events, unknown src/device are dropped, never stored;
 *  - staff and "view as client" sessions never produce rows (the
 *    recovery_sent_at poisoning precedent — staff testing must not move
 *    adoption stats);
 *  - contact identity is SERVER-derived from the session, never accepted
 *    from the body;
 *  - in-memory rate limit as abuse damping (best-effort per instance, by
 *    design — see lib/portal/rate-limit.ts).
 * The response is always {ok:true} on drops: an anonymous telemetry sink
 * must not teach a prober which payloads are stored.
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { getClientContactId } from '@/lib/portal-auth'
import { checkRateLimit, getRateLimitKey } from '@/lib/portal/rate-limit'
import { parsePwaEventPayload } from '@/lib/portal/pwa-events'
import { verifyViewAs, VIEW_AS_COOKIE } from '@/lib/portal/view-as'

export const dynamic = 'force-dynamic'

const MAX_UA_LENGTH = 400

export async function POST(req: NextRequest) {
  try {
    const limit = checkRateLimit(getRateLimitKey(req), 60, 60_000)
    if (!limit.allowed) {
      return NextResponse.json({ ok: false }, { status: 429 })
    }

    const body = await req.json().catch(() => null)
    const payload = parsePwaEventPayload(body)
    if (!payload) {
      return NextResponse.json({ ok: false }, { status: 400 })
    }

    // "View as client" sessions mint the client's REAL session — without this
    // check, Antonio testing a client's portal would write contact-attributed
    // adoption rows (the exact recovery_sent_at trap).
    const viewAsMarker = req.cookies.get(VIEW_AS_COOKIE)?.value
    if (viewAsMarker && (await verifyViewAs(viewAsMarker))) {
      return NextResponse.json({ ok: true })
    }

    // Session (optional — the install page is anonymous). Staff sessions are
    // dropped; client/team sessions attach the server-derived contact id.
    let contactId: string | null = null
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      const role = user.app_metadata?.role
      const kind = (user.app_metadata as Record<string, unknown>)?.kind
      if (role !== 'client' && kind !== 'team_member') {
        // Staff / admin / partner — never count.
        return NextResponse.json({ ok: true })
      }
      contactId = getClientContactId(user)
    }

    // pwa_events is not in the generated database types: regenerating them is
    // deliberately blocked (schema-drift decision, see
    // reference_ci_schema_drift_unfixable) — same cast precedent as
    // lib/mcp/tools/sysdocs.ts sysdoc_read_log.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabaseAdmin as any).from('pwa_events').insert({
      event: payload.event,
      src: payload.src ?? null,
      device: payload.device ?? null,
      contact_id: contactId,
      user_agent: (req.headers.get('user-agent') || '').slice(0, MAX_UA_LENGTH) || null,
    })

    return NextResponse.json({ ok: true })
  } catch {
    // Telemetry must never surface an error to the caller.
    return NextResponse.json({ ok: true })
  }
}
