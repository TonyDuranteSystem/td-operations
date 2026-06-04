/**
 * Approvable tools — the action-authorization allow-list (Phase 2, Slice 1).
 *
 * Phase 1 of the Hermes ↔ Claude bridge is research-only: the worker can read
 * but never act. Phase 2 introduces an approval rail — the worker may *propose*
 * an action (via the propose_action worker tool), which lands in approval_queue
 * as a pending row for Antonio to approve before anything runs.
 *
 * This module is the PURE, DB-FREE half of that rail:
 *   - APPROVABLE_TOOL_NAMES — the closed set of action tools that may be proposed.
 *   - isApprovableTool(name) — membership check.
 *   - APPROVABLE_TOOL_CONSTRAINTS — per-tool metadata the approval UI uses to
 *     surface the right params and flag risk (external sends, cascades, etc.).
 *   - computeParamsHash(params) — SHA-256 of JSON.stringify(params).
 *   - validateToolParams(name, params) — validates params against the tool's
 *     JSON-Schema in AGENT_TOOLS, so a malformed proposal is rejected at propose
 *     time, not at execute time.
 *
 * Keeping this DB-free means it's trivially unit-testable and safe to import on
 * the client if a future approval UI needs the constraint metadata.
 *
 * SAFETY: this is an ALLOW-LIST, not a deny-list. A tool not named here can never
 * be proposed. Adding a tool is a deliberate decision — it means "Antonio may be
 * asked to approve running this." Every name here MUST also exist in AGENT_TOOLS
 * (a unit test asserts this).
 */

import { createHash } from "crypto"
import { AGENT_TOOLS } from "./tools"

/**
 * The closed set of action tools the bridge worker may propose. All 12 map to
 * real AGENT_TOOLS entries. Read-only research tools are NOT here — they don't
 * need approval, the worker just calls them directly in Phase 1.
 */
export const APPROVABLE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "create_task",
  "update_task",
  "update_account_notes",
  "update_contact",
  "update_service",
  "advance_service_stage",
  "send_email",
  "drive_move",
  "drive_upload_file",
  "gmail_get_attachments",
  "log_conversation",
  "save_memory",
])

/** Is this tool one Antonio can be asked to approve? */
export function isApprovableTool(name: string): boolean {
  return APPROVABLE_TOOL_NAMES.has(name)
}

/**
 * Per-tool constraint metadata for the approval card (later slices render this).
 *  - label:        human-friendly action name.
 *  - surface:      param keys the approver MUST see before deciding (e.g. the
 *                  recipient + body of an email). The UI highlights these.
 *  - external:     the action leaves TD's systems (sends to a third party) —
 *                  extra caution; effectively irreversible once sent.
 *  - cascades:     the action triggers downstream effects beyond the row it
 *                  touches (auto-tasks, stage transitions).
 *  - irreversible: hard or impossible to undo once executed.
 */
export interface ApprovableToolConstraint {
  label: string
  surface: string[]
  external?: boolean
  cascades?: boolean
  irreversible?: boolean
}

export const APPROVABLE_TOOL_CONSTRAINTS: Readonly<Record<string, ApprovableToolConstraint>> = {
  create_task: {
    label: "Create CRM task",
    surface: ["task_title", "assigned_to", "due_date", "account_id"],
  },
  update_task: {
    label: "Update CRM task",
    surface: ["task_id", "status", "assigned_to", "notes"],
  },
  update_account_notes: {
    label: "Append note to account",
    surface: ["account_id", "note"],
  },
  update_contact: {
    label: "Update contact",
    surface: ["contact_id", "phase", "notes"],
  },
  update_service: {
    label: "Update service",
    surface: ["service_id", "status", "notes"],
  },
  advance_service_stage: {
    // Moving a pipeline stage auto-creates tasks defined in pipeline_stages.
    label: "Advance service stage",
    surface: ["service_id", "notes"],
    cascades: true,
  },
  send_email: {
    // Leaves the building. Approver MUST see to/subject/body verbatim.
    label: "Send email",
    surface: ["to", "subject", "body", "reply_to_message_id"],
    external: true,
    irreversible: true,
  },
  drive_move: {
    label: "Move Drive file",
    surface: ["file_id", "target_folder_id"],
  },
  drive_upload_file: {
    // Writes a file into Drive (client-visible storage).
    label: "Upload file to Drive",
    surface: ["file_name", "folder_id", "source_url"],
  },
  gmail_get_attachments: {
    // Read-only UNLESS save_to_drive=true, which writes attachments into Drive.
    label: "Save Gmail attachments to Drive",
    surface: ["message_id", "save_to_drive", "drive_folder_id"],
  },
  log_conversation: {
    label: "Log conversation",
    surface: ["account_id", "contact_id", "channel", "topic"],
  },
  save_memory: {
    label: "Save agent memory",
    surface: ["key", "scope"],
  },
}

/**
 * Recursively sort object keys so two structurally-equal objects with different
 * key orders serialize identically. Arrays keep their order (semantically
 * meaningful, and JSONB preserves array order); scalars pass through.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = canonicalize(obj[k])
        return acc
      }, {})
  }
  return value
}

/**
 * Canonical params hash — SHA-256 hex of the KEY-ORDER-CANONICAL JSON of params.
 * Used to detect drift between what was approved and what would actually run at
 * execute time.
 *
 * CRITICAL: the hash MUST be independent of object key order. The proposal is
 * stored in Postgres as JSONB, which does NOT preserve insertion order (it
 * reorders keys internally). If we hashed `JSON.stringify(params)` as-is, the
 * propose-time hash (insertion order) would never match the execute-time hash
 * (JSONB-returned order) for any params with ≥2 keys — silently failing the
 * integrity check on every real action. Canonicalizing both sides fixes that.
 * (Found via the Slice 2 sandbox E2E, 2026-06-04 — mocks preserved key order so
 * unit tests missed it; a regression test now pins key-order independence.)
 */
export function computeParamsHash(params: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(params ?? {}))).digest("hex")
}

export interface ParamValidationResult {
  ok: boolean
  errors: string[]
}

/**
 * Minimal JSON-Schema validation covering the constructs AGENT_TOOLS actually
 * uses: { type: 'object', properties: {...}, required?: [...] } with per-property
 * `type` and optional `enum`. Rejects:
 *   - missing required keys
 *   - type mismatches on provided keys
 *   - enum violations on provided keys
 * Unknown extra keys are allowed (AGENT_TOOLS schemas don't set
 * additionalProperties:false; being lenient here avoids false rejections while
 * still catching the dangerous cases — wrong/missing required fields).
 */
export function validateToolParams(toolName: string, params: unknown): ParamValidationResult {
  const tool = AGENT_TOOLS.find((t) => t.name === toolName)
  if (!tool) {
    return { ok: false, errors: [`Unknown tool "${toolName}" — not in AGENT_TOOLS.`] }
  }

  const schema = tool.parameters as {
    type?: string
    properties?: Record<string, { type?: string; enum?: unknown[] }>
    required?: string[]
  }

  const errors: string[] = []

  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    return { ok: false, errors: [`params must be an object for "${toolName}".`] }
  }
  const p = params as Record<string, unknown>

  // Required keys present.
  for (const key of schema.required ?? []) {
    if (p[key] === undefined || p[key] === null) {
      errors.push(`Missing required param "${key}" for "${toolName}".`)
    }
  }

  // Type + enum checks on provided keys.
  const props = schema.properties ?? {}
  for (const [key, value] of Object.entries(p)) {
    const spec = props[key]
    if (!spec) continue // unknown extra key — lenient
    if (value === undefined || value === null) continue
    if (spec.type && !matchesJsonType(value, spec.type)) {
      errors.push(`Param "${key}" must be of type ${spec.type} for "${toolName}".`)
    }
    if (spec.enum && !spec.enum.includes(value)) {
      errors.push(`Param "${key}" must be one of [${spec.enum.join(", ")}] for "${toolName}".`)
    }
  }

  return { ok: errors.length === 0, errors }
}

function matchesJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string"
    case "number":
    case "integer":
      return typeof value === "number" && Number.isFinite(value)
    case "boolean":
      return typeof value === "boolean"
    case "array":
      return Array.isArray(value)
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value)
    default:
      return true // unknown declared type — don't block
  }
}
