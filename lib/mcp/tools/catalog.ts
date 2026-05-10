/**
 * Catalog Governance MCP Tools — Phase 6a.
 *
 * Chat-side surface for managing the catalog framework
 * (`catalog_definitions` / `catalog_entries` / `catalog_decision_log` /
 * `catalog_pending_review`). Every mutation flows through the same
 * `lib/catalog/framework.ts` helpers used by the admin UI in
 * `app/(dashboard)/catalog/page.tsx`, so DB state ends up identical
 * regardless of which surface drove the change.
 *
 * Tools: catalog_list, catalog_add, catalog_update, catalog_pending.
 *
 * Spec: sysdoc `ops-2026-05-09-catalog-framework-spec`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import {
  type Actor,
  addEntry,
  deprecateEntry,
  type EntryStatus,
  getEntry,
  listEntries,
  listPendingReview,
  type PendingReviewStatus,
  renameEntry,
  resolvePendingReview,
  restoreEntry,
  tagEntry,
} from "@/lib/catalog/framework"

const CHAT_ACTOR: Actor = { kind: "chat", userId: null }

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] }
}

function err(prefix: string, e: unknown) {
  const msg = e instanceof Error ? e.message : String(e)
  return ok(`❌ ${prefix}: ${msg}`)
}

export function registerCatalogTools(server: McpServer) {
  // ── catalog_list ────────────────────────────────────────────────────────
  server.tool(
    "catalog_list",
    "List entries in a catalog. Defaults to active+exception_only (excludes deprecated). Use catalog_id='services' for the Services & SD-Types catalog. Returns a JSON table of {slug, display_name, status, tags}.",
    {
      catalog_id: z.string().describe("Catalog id, e.g. 'services'"),
      status_filter: z
        .enum(["active", "deprecated", "exception_only", "all"])
        .optional()
        .describe("Filter by status. 'all' includes deprecated. Default: excludes deprecated."),
      tag_filter: z
        .string()
        .optional()
        .describe("Single tag the entry must contain (e.g. 'service', 'sellable', 'sd')."),
    },
    async ({ catalog_id, status_filter, tag_filter }) => {
      try {
        const opts: { status?: EntryStatus; tags?: string[]; includeDeprecated?: boolean } = {}
        if (status_filter && status_filter !== "all") {
          opts.status = status_filter
        } else if (status_filter === "all") {
          opts.includeDeprecated = true
        }
        if (tag_filter) opts.tags = [tag_filter]

        const rows = await listEntries(catalog_id, opts)
        const trimmed = rows.map((r) => ({
          slug: r.slug,
          display_name: r.display_name,
          status: r.status,
          tags: r.tags,
        }))
        return ok(JSON.stringify({ catalog_id, count: trimmed.length, entries: trimmed }, null, 2))
      } catch (e) {
        return err("catalog_list", e)
      }
    },
  )

  // ── catalog_add ─────────────────────────────────────────────────────────
  server.tool(
    "catalog_add",
    "Add a new entry to a catalog. Writes a catalog_decision_log row with the supplied reason. Slugs are immutable and unique per catalog. Use catalog_update to rename later. Tags are free-form strings (e.g. ['service','sellable']).",
    {
      catalog_id: z.string().describe("Catalog id, e.g. 'services'"),
      slug: z
        .string()
        .min(1)
        .regex(/^[a-z0-9_]+$/, "lowercase snake_case only")
        .describe("Stable snake_case identifier — never changes after creation"),
      display_name: z.string().min(1).describe("Human-readable label in English"),
      description: z.string().optional().describe("Optional plain-English description"),
      status: z
        .enum(["active", "deprecated", "exception_only"])
        .default("active")
        .describe("Initial status (default: active)"),
      tags: z.array(z.string()).optional().describe("Behavioral tags — e.g. ['service','sellable']"),
      reason: z
        .string()
        .min(1)
        .describe("Plain-English why — captured in catalog_decision_log for audit"),
    },
    async ({ catalog_id, slug, display_name, description, status, tags, reason }) => {
      try {
        const created = await addEntry(
          catalog_id,
          {
            slug,
            display_name,
            status,
            description: description ?? null,
            tags: tags ?? [],
          },
          reason,
          CHAT_ACTOR,
        )
        return ok(
          `✅ Added ${catalog_id}/${created.slug} (${created.status})\n` +
            JSON.stringify(
              {
                id: created.id,
                slug: created.slug,
                display_name: created.display_name,
                status: created.status,
                tags: created.tags,
              },
              null,
              2,
            ),
        )
      } catch (e) {
        return err("catalog_add", e)
      }
    },
  )

  // ── catalog_update ──────────────────────────────────────────────────────
  server.tool(
    "catalog_update",
    "Rename, deprecate, restore, or retag an existing catalog entry. Identified by (catalog_id, slug). Every action writes a catalog_decision_log row with the supplied reason. For 'rename' pass new_value=<new display name>. For 'tag' pass new_tags=<full new tag array> (replaces existing). For 'deprecate'/'restore' new_value/new_tags are ignored.",
    {
      catalog_id: z.string().describe("Catalog id, e.g. 'services'"),
      slug: z.string().describe("Slug of the entry to update"),
      action: z
        .enum(["rename", "deprecate", "restore", "tag"])
        .describe("Which mutation to apply"),
      new_value: z
        .string()
        .optional()
        .describe("New display_name when action='rename'"),
      new_tags: z
        .array(z.string())
        .optional()
        .describe("Replacement tag array when action='tag'"),
      reason: z.string().min(1).describe("Plain-English why — captured in catalog_decision_log"),
    },
    async ({ catalog_id, slug, action, new_value, new_tags, reason }) => {
      try {
        const entry = await getEntry(catalog_id, slug)
        if (!entry) {
          return ok(`❌ catalog_update: entry not found: ${catalog_id}/${slug}`)
        }

        let updated
        if (action === "rename") {
          if (!new_value || !new_value.trim()) {
            return ok("❌ catalog_update: new_value (new display_name) required for action='rename'")
          }
          updated = await renameEntry(entry.id, new_value, reason, CHAT_ACTOR)
        } else if (action === "deprecate") {
          updated = await deprecateEntry(entry.id, reason, CHAT_ACTOR)
        } else if (action === "restore") {
          updated = await restoreEntry(entry.id, reason, CHAT_ACTOR)
        } else if (action === "tag") {
          if (!new_tags) {
            return ok("❌ catalog_update: new_tags array required for action='tag'")
          }
          updated = await tagEntry(entry.id, new_tags, reason, CHAT_ACTOR)
        } else {
          return ok(`❌ catalog_update: unknown action '${action as string}'`)
        }

        return ok(
          `✅ ${action} ${catalog_id}/${updated.slug}\n` +
            JSON.stringify(
              {
                id: updated.id,
                slug: updated.slug,
                display_name: updated.display_name,
                status: updated.status,
                tags: updated.tags,
              },
              null,
              2,
            ),
        )
      } catch (e) {
        return err("catalog_update", e)
      }
    },
  )

  // ── catalog_pending ─────────────────────────────────────────────────────
  server.tool(
    "catalog_pending",
    "Manage the catalog_pending_review queue. action='list' shows pending rows (unrecognized values from external sources). action='resolve' marks one row as approved+aliased to an existing slug, or as rejected. To create a new slug for a pending value, call catalog_add first, then catalog_pending(action='resolve', resolved_to_slug=<new slug>).",
    {
      action: z
        .enum(["list", "resolve"])
        .describe("'list' = view queue. 'resolve' = mark one row as approved-aliased or rejected."),
      catalog_id: z
        .string()
        .optional()
        .describe("Filter list by catalog_id (e.g. 'services'). Optional for list."),
      status_filter: z
        .enum(["pending", "approved_added", "approved_aliased", "rejected", "all"])
        .optional()
        .describe("List filter — default 'pending'."),
      pending_id: z
        .string()
        .uuid()
        .optional()
        .describe("Pending review row id. Required for action='resolve'."),
      resolved_to_slug: z
        .string()
        .optional()
        .describe("Slug to alias the submitted value to. Required for action='resolve' when reject=false."),
      reject: z
        .boolean()
        .optional()
        .describe("If true, mark the pending row as rejected instead of aliased. Default: false."),
      reason: z
        .string()
        .optional()
        .describe("Plain-English why — required for action='resolve'."),
    },
    async ({ action, catalog_id, status_filter, pending_id, resolved_to_slug, reject, reason }) => {
      try {
        if (action === "list") {
          const rows = await listPendingReview({
            catalogId: catalog_id,
            status: (status_filter ?? "pending") as PendingReviewStatus | "all",
          })
          const trimmed = rows.map((r) => ({
            id: r.id,
            catalog_id: r.catalog_id,
            submitted_value: r.submitted_value,
            source: r.source,
            status: r.status,
            resolved_to_entry_id: r.resolved_to_entry_id,
            created_at: r.created_at,
          }))
          return ok(
            JSON.stringify(
              { count: trimmed.length, status_filter: status_filter ?? "pending", pending: trimmed },
              null,
              2,
            ),
          )
        }

        // action === 'resolve'
        if (!pending_id) {
          return ok("❌ catalog_pending: pending_id is required for action='resolve'")
        }
        if (!reason || !reason.trim()) {
          return ok("❌ catalog_pending: reason is required for action='resolve'")
        }

        if (reject) {
          const resolved = await resolvePendingReview(
            pending_id,
            "rejected",
            null,
            reason,
            CHAT_ACTOR,
          )
          return ok(
            `✅ rejected pending ${resolved.id}\n` +
              JSON.stringify(
                {
                  id: resolved.id,
                  status: resolved.status,
                  resolved_at: resolved.resolved_at,
                },
                null,
                2,
              ),
          )
        }

        if (!resolved_to_slug) {
          return ok(
            "❌ catalog_pending: resolved_to_slug is required for action='resolve' when reject=false (or pass reject=true to reject)",
          )
        }

        // Look up the pending row to learn its catalog_id, then resolve target slug.
        const pendingRows = await listPendingReview({ catalogId: undefined, status: "all" })
        const pending = pendingRows.find((r) => r.id === pending_id)
        if (!pending) {
          return ok(`❌ catalog_pending: pending row not found: ${pending_id}`)
        }
        const target = await getEntry(pending.catalog_id, resolved_to_slug)
        if (!target) {
          return ok(
            `❌ catalog_pending: slug '${resolved_to_slug}' not found in catalog '${pending.catalog_id}'`,
          )
        }

        const resolved = await resolvePendingReview(
          pending_id,
          "approved_aliased",
          target.id,
          reason,
          CHAT_ACTOR,
        )
        return ok(
          `✅ aliased pending ${resolved.id} → ${pending.catalog_id}/${target.slug}\n` +
            JSON.stringify(
              {
                id: resolved.id,
                status: resolved.status,
                resolved_to_entry_id: resolved.resolved_to_entry_id,
                resolved_at: resolved.resolved_at,
              },
              null,
              2,
            ),
        )
      } catch (e) {
        return err("catalog_pending", e)
      }
    },
  )
}
