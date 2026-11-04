# Supabase status (the "it is Supabase, not you" message)
_Last verified against code: 2026-11-04 — Claude (dev job `2072bc3e`, SANDBOX, Step 1b of the TD Social plan; sandbox build in a pull request, not in production): inside the TD Social phone app the red notice (`components/infra/supabase-incident-bar.tsx`) takes ONE line (tap to read it all, 44 px close button) and stays visible on the CRM screens, TD Talk and Marketing Chat; elsewhere it is unchanged. Details: `docs/systems/social-app.md`._
_Last verified against code: 2026-11-02 — Claude (dev job `dd1c6a6d`, SANDBOX). Antonio, after a Supabase storage outage (21:34-22:48 UTC) that looked like a problem on Luca's side for an hour and a half: "I don't want just a general message or warning. I want the message to say that the issue is in Supabase, so we know."_

## What it does
When Supabase (our database and file storage) has an OPEN incident that can hurt us, the team is told so in Supabase's own words, in three places, and a client sees a neutral line:
1. **A red bar** across the top of the CRM (inside the main area, under the header), TD Talk and the TD Marketing workspace: "Supabase reports an incident: “<title>” (since 21:34 UTC). Latest update (22:23 UTC): <text>. Files may not save. This is not your connection." It can be closed; it comes back when Supabase posts a new update. Component `components/infra/supabase-incident-bar.tsx` (polls every 60 s while the window is in front, and on focus).
2. **The failed-upload message.** The workspace upload (`components/flows/document-upload.tsx`) and a chat message waiting in the outbox (`components/talk/talk-messages.tsx`, see `talk.md` 2026-11-02c) say "Supabase has an open storage incident (“…”). Your file did not save because of it, not because of your connection." instead of the generic text. Helper: `explainUploadFailure` / `incidentHintFor` in `lib/infra/incident-client.ts`.
3. **One notification each** to Antonio, Luca and Jodi when an incident opens and one when it is resolved (cron `/api/cron/supabase-status`, every 3 minutes, `vercel.json`). Sent with `dm: true` so a person with TD Talk installed gets it there and everybody else in the CRM app, once each.
4. **Clients** (portal): an amber line "Uploads are temporarily unavailable, please try again shortly." while a STORAGE incident is open; never the cause.

## How it works
- Source: Supabase's public feed `https://status.supabase.com/api/v2/incidents.json` (override with `SUPABASE_STATUS_FEED_URL`, used by tests). `lib/infra/supabase-status-server.ts` reads it (5 s timeout, cached 60 s). A feed that cannot be read gives `{ unknown: true }` — the UI shows NOTHING (never an all-clear) and the cron says nothing.
- Rules (pure, `lib/infra/supabase-status.ts`): open = not `resolved`/`postmortem`; relevant = the TITLE names a service we stand on (storage, database, postgres, auth, realtime, rest api, pooler, connection, edge functions, upload) and not only Supabase tooling (logs, dashboard, support, management API, project creation); a title naming a region other than ours is ignored; "multiple regions" / "all regions" / no region count as ours. **Our region = `SUPABASE_REGION`, default `us-east-1`. THE PRODUCTION REGION HAS NOT BEEN CONFIRMED** (the sandbox is us-east-1; production's could not be read from the code or the database): confirm it in the Supabase dashboard (Project settings) and set `SUPABASE_REGION` if different.
- Three addresses, one handler (`lib/infra/status-route.ts`), because the door rules confine a marketing login to `/api/marketing/*` and a client to `/api/portal/*`: `/api/infra/supabase-status` (staff), `/api/marketing/supabase-status`, `/api/portal/supabase-status`. Staff and the Marketing team get `{ audience: 'staff', incident }`; anybody else signed in gets `{ audience: 'client', uploadsDown }`; signed out = 401.
- "Once" for the notifications: table `infra_incident_notices` (migration `20261102-2300-infra-incident-notices.sql`, RLS on, no policies, service role only). `claimOpened` inserts (a second insert hits the primary key and answers false); `claimResolved` updates only a row we announced opened and not yet resolved. `lib/infra/supabase-status-notify.ts` is the pure orchestration (unit-tested). Recipients = `NOTICE_RECIPIENT_EMAILS`, matched to logins with `listTeamMembers`. `?dry_run=1` (with the cron secret) lists what would be announced and records/sends nothing.

## Rules
- Quote Supabase's words; never paraphrase the cause. Never show a client the cause.
- Never claim "all clear" from silence or an unreadable feed.
- The table must exist in production BEFORE the cron deploys (migration first): without it the cron logs an error each run and announces nothing; the bar and the messages work without it.

## How to verify current state
- `curl -s https://status.supabase.com/api/v2/incidents.json | head` — what Supabase says now.
- As staff, `GET /api/infra/supabase-status` — `{ audience: 'staff', incident: null }` when all is well.
- Sandbox test without a real incident: set `SUPABASE_STATUS_FEED_URL` to a fake feed and open any CRM page.
- `select * from infra_incident_notices order by created_at desc` — what the team was told and when.

## Not covered / known limits
- A Supabase problem that Supabase has not posted yet (or that is not in the feed) is not shown. A check that uploads a tiny test file would catch that; not built.
- The client portal's own upload dialogs keep their own error screens; the amber line above them is the explanation.
- Push only reaches people who turned notifications on.
