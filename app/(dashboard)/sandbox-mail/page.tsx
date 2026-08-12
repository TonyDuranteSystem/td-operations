/**
 * /sandbox-mail — QA-only viewer for outbound emails the sandbox blocked.
 *
 * Sandbox delivers no real email (SANDBOX_MODE), so this is where a tester reads
 * what a client WOULD have received — the exact subject, recipient, body, and the
 * signing links. It lives under the dashboard group, so it is staff-session-gated
 * by the same middleware as every other CRM page. In production it renders a
 * short "sandbox only" notice and reads nothing (the capture never runs there).
 */

export const dynamic = "force-dynamic"

import { supabaseAdmin } from "@/lib/supabase-admin"

interface CapturedEmail {
  id: string
  recipient: string | null
  subject: string | null
  body: string | null
  links: string[] | null
  created_at: string
}

export default async function SandboxMailPage() {
  const isSandbox = process.env.SANDBOX_MODE === "1"

  if (!isSandbox) {
    return (
      <div className="p-8 max-w-2xl">
        <h1 className="text-xl font-semibold mb-2">Sandbox Mail</h1>
        <p className="text-muted-foreground text-sm">
          This viewer only works in the sandbox environment, where outbound email is captured instead of sent.
          In production, real email is delivered normally and nothing is captured here.
        </p>
      </div>
    )
  }

  const { data } = await supabaseAdmin
    .from("sandbox_captured_emails")
    .select("id, recipient, subject, body, links, created_at")
    .order("created_at", { ascending: false })
    .limit(50)
  const emails = (data ?? []) as unknown as CapturedEmail[]

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-xl font-semibold">Sandbox Mail</h1>
      <p className="text-muted-foreground text-sm mt-1 mb-5">
        Outbound emails the sandbox captured instead of sending (newest first). This is the exact content a client
        would have received, including any signing links.
      </p>

      {emails.length === 0 ? (
        <p className="text-sm text-muted-foreground">No captured emails yet. Trigger an action that sends one (e.g. Re-send signing links) and refresh.</p>
      ) : (
        <ul className="space-y-4">
          {emails.map(e => (
            <li key={e.id} className="rounded-lg border border-zinc-200 bg-white p-4">
              <div className="flex items-baseline justify-between gap-3">
                <p className="font-medium text-sm">{e.subject || "(no subject)"}</p>
                <time className="text-xs text-zinc-400 shrink-0">{new Date(e.created_at).toLocaleString()}</time>
              </div>
              <p className="text-xs text-zinc-500 mt-0.5">To: {e.recipient || "(unknown)"}</p>

              {e.links && e.links.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs font-semibold text-zinc-600 mb-1">Links in this email:</p>
                  <ul className="space-y-1">
                    {e.links.map((l, i) => (
                      <li key={i}>
                        <a href={l} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline text-xs break-all">{l}</a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {e.body && (
                <details className="mt-3">
                  <summary className="text-xs text-zinc-500 cursor-pointer">Show full body</summary>
                  <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-zinc-700 bg-zinc-50 rounded p-3 max-h-96 overflow-auto">{e.body}</pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
