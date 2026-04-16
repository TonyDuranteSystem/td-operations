/**
 * Work Locks MCP Tools — P2.1 advisory cross-machine coordination.
 *
 * 3 tools surfaced to MCP clients:
 *   work_claim   — claim a file before editing on another machine
 *   work_release — release a previously claimed lock
 *   work_list    — list active (or all) locks
 *
 * Advisory only: these locks DO NOT block writes. They expose state via
 * `work_list` so a session on one machine can see that another machine has
 * claimed `lib/portal/wizard.ts` and avoid stomping on its work.
 *
 * Table: work_locks (Supabase)
 *   - Partial unique index on (file_path WHERE released_at IS NULL)
 *     enforces "at most one active lock per file" at the DB level. A
 *     duplicate claim returns 23505 and is reported as a conflict.
 *   - RLS enabled with no policies (service_role bypass via supabaseAdmin).
 */

import os from "node:os"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"

/** Default `locked_by` when caller does not supply one. */
export function defaultLockedBy(): string {
  // Prefer explicit env override (multi-machine setups can pin per host).
  // Fall back to OS hostname (e.g. "MacBook-Antonio.local").
  return process.env.MACHINE_ID || os.hostname() || "unknown"
}

export function fmtAge(claimedAtIso: string): string {
  const ms = Date.now() - new Date(claimedAtIso).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return "<1m"
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  const remMins = mins % 60
  return `${hrs}h${remMins ? ` ${remMins}m` : ""}`
}

export function registerLockTools(server: McpServer) {

  // ─── work_claim ──────────────────────────────────────────
  server.tool(
    "work_claim",
    "Claim a file (or path) for editing — advisory cross-machine lock. Surfaces in work_list so other sessions can see the file is being edited. Returns conflict if another active lock already exists for the same file_path. Does NOT block writes — visibility only. Use BEFORE editing files that another machine might also be editing.",
    {
      file_path: z.string().min(1).describe("Repo-relative path or glob (e.g. 'lib/portal/wizard.ts'). One active lock per exact file_path."),
      reason: z.string().min(1).describe("What you intend to do with this file (e.g. 'Refactoring tax wizard step 3')."),
      locked_by: z.string().optional().describe("Identifier of the claimer. Defaults to MACHINE_ID env var or os.hostname()."),
    },
    async ({ file_path, reason, locked_by }) => {
      const claimer = locked_by ?? defaultLockedBy()
      try {
        const { data, error } = await supabaseAdmin
          .from("work_locks")
          .insert({ file_path, reason, locked_by: claimer })
          .select("id, file_path, locked_by, reason, claimed_at")
          .single()

        if (error) {
          // 23505 = unique_violation on partial index (active lock already exists).
          if (error.code === "23505") {
            const { data: existing } = await supabaseAdmin
              .from("work_locks")
              .select("id, locked_by, reason, claimed_at")
              .eq("file_path", file_path)
              .is("released_at", null)
              .order("claimed_at", { ascending: false })
              .limit(1)
              .maybeSingle()
            const owner = existing?.locked_by ?? "unknown"
            const why = existing?.reason ?? "(no reason recorded)"
            const age = existing ? fmtAge(existing.claimed_at) : "?"
            return {
              content: [{
                type: "text" as const,
                text: `⛔ Lock conflict on ${file_path}\n• Held by: ${owner} (${age} ago)\n• Reason: ${why}\n• Lock id: ${existing?.id ?? "?"}\n\nIf the holder is gone, release it with work_release({ file_path: '${file_path}' }).`,
              }],
            }
          }
          throw error
        }

        return {
          content: [{
            type: "text" as const,
            text: `🔒 Claimed ${data.file_path}\n• Lock id: ${data.id}\n• Owner: ${data.locked_by}\n• Reason: ${data.reason}\n\nRelease with work_release({ lock_id: '${data.id}' }) when done.`,
          }],
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return { content: [{ type: "text" as const, text: `❌ work_claim failed: ${message}` }] }
      }
    }
  )

  // ─── work_release ────────────────────────────────────────
  server.tool(
    "work_release",
    "Release a previously claimed work lock. Pass either lock_id (preferred) or file_path. Idempotent — releasing an already-released lock is a no-op (returns success).",
    {
      lock_id: z.string().uuid().optional().describe("UUID of the lock to release."),
      file_path: z.string().optional().describe("File path of the active lock to release. Used only if lock_id is not provided."),
    },
    async ({ lock_id, file_path }) => {
      if (!lock_id && !file_path) {
        return { content: [{ type: "text" as const, text: "❌ work_release: provide lock_id or file_path." }] }
      }
      try {
        const query = supabaseAdmin
          .from("work_locks")
          .update({ released_at: new Date().toISOString() })
          .is("released_at", null)
          .select("id, file_path, locked_by, claimed_at")

        const { data, error } = lock_id
          ? await query.eq("id", lock_id)
          : await query.eq("file_path", file_path!)

        if (error) throw error

        if (!data || data.length === 0) {
          const target = lock_id ? `id=${lock_id}` : `file_path=${file_path}`
          return { content: [{ type: "text" as const, text: `ℹ️ No active lock for ${target} (already released or never claimed).` }] }
        }

        const lines = data.map(r => `• ${r.file_path} (held by ${r.locked_by}, ${fmtAge(r.claimed_at)})`)
        return {
          content: [{
            type: "text" as const,
            text: `🔓 Released ${data.length} lock${data.length === 1 ? "" : "s"}:\n${lines.join("\n")}`,
          }],
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return { content: [{ type: "text" as const, text: `❌ work_release failed: ${message}` }] }
      }
    }
  )

  // ─── work_list ───────────────────────────────────────────
  server.tool(
    "work_list",
    "List active work locks across machines. Use at session start (or before editing shared files) to see what other sessions are working on. Returns empty list if no active locks. Pass include_released=true to also see recent (last 24h) released locks.",
    {
      include_released: z.boolean().default(false).describe("If true, also return locks released in the last 24h."),
      file_path: z.string().optional().describe("Filter to a specific file_path."),
    },
    async ({ include_released, file_path }) => {
      try {
        let q = supabaseAdmin
          .from("work_locks")
          .select("id, file_path, locked_by, reason, claimed_at, released_at")
          .order("claimed_at", { ascending: false })
          .limit(50)

        if (file_path) q = q.eq("file_path", file_path)

        if (include_released) {
          // Active OR released-in-last-24h.
          const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
          q = q.or(`released_at.is.null,released_at.gte.${cutoff}`)
        } else {
          q = q.is("released_at", null)
        }

        const { data, error } = await q
        if (error) throw error

        if (!data || data.length === 0) {
          return { content: [{ type: "text" as const, text: include_released ? "ℹ️ No locks in the last 24h." : "ℹ️ No active work locks." }] }
        }

        const lines = data.map(r => {
          const status = r.released_at ? `released ${fmtAge(r.released_at)} ago` : `active ${fmtAge(r.claimed_at)}`
          return `• ${r.file_path}\n  by ${r.locked_by} — ${status}\n  reason: ${r.reason}\n  id: ${r.id}`
        })
        const header = include_released
          ? `📋 ${data.length} lock${data.length === 1 ? "" : "s"} (active + released in last 24h):`
          : `🔒 ${data.length} active lock${data.length === 1 ? "" : "s"}:`
        return { content: [{ type: "text" as const, text: `${header}\n${lines.join("\n")}` }] }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return { content: [{ type: "text" as const, text: `❌ work_list failed: ${message}` }] }
      }
    }
  )
}
