/**
 * itin.confirm_number_received — Service-specific handler for the
 * "ITIN number received" action on the itin_irs_processing workflow.
 *
 * The IRS mails back the ITIN. Operator types the number + (optionally)
 * pastes the Drive URL of the IRS letter. This handler:
 *   1. Validates the ITIN format (9 digits, starts with 9).
 *   2. Parses the Drive file ID from the IRS letter URL (if provided).
 *   3. Stamps contacts.itin_number + contacts.itin_issue_date via the
 *      audited updateContact helper.
 *   4. Carries forward the inputs in task_meta so the next workflow
 *      (itin_number_received → "Deliver ITIN to client") can reference
 *      them when composing the client-facing message.
 *
 * The catalog transition (defined in services.itin.metadata.workflow_chain)
 * handles spawning the next workflow + advancing the SD; this handler
 * just stamps state.
 *
 * Expected params shape (multi-field requires_input):
 *   itin_number          (required, validated to /^9\d{8}$/ stripped of dashes)
 *   itin_issue_date      (optional, ISO date; defaults to today)
 *   irs_letter_drive_url (optional, URL or bare Drive file ID)
 */

import { updateContact } from "@/lib/operations/contact"
import type { HandlerContext, HandlerResult, WorkflowHandler } from "@/lib/tasks/types"

const ITIN_FORMAT = /^9\d{8}$/

function normalizeItin(raw: string): string {
  return raw.replace(/[^0-9]/g, "")
}

/**
 * Extract a Drive file ID from a Drive URL or accept a bare file ID.
 * Returns null on failure (so the handler can skip the letter side-effect).
 */
function parseDriveFileId(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  // Bare file ID: alphanumeric + - and _, length ~25-50.
  if (/^[A-Za-z0-9_-]{20,}$/.test(trimmed)) return trimmed
  // URLs: /file/d/<ID>/, /folders/<ID>, ?id=<ID>
  const fileMatch = trimmed.match(/\/file\/d\/([A-Za-z0-9_-]{20,})/)
  if (fileMatch) return fileMatch[1]
  const folderMatch = trimmed.match(/\/folders\/([A-Za-z0-9_-]{20,})/)
  if (folderMatch) return folderMatch[1]
  const queryMatch = trimmed.match(/[?&]id=([A-Za-z0-9_-]{20,})/)
  if (queryMatch) return queryMatch[1]
  return null
}

export const itinConfirmNumberReceived: WorkflowHandler = async (
  ctx: HandlerContext,
): Promise<HandlerResult> => {
  const params = (ctx.params ?? {}) as {
    itin_number?: unknown
    itin_issue_date?: unknown
    irs_letter_drive_url?: unknown
  }

  const rawItin = typeof params.itin_number === "string" ? params.itin_number.trim() : ""
  const normalized = normalizeItin(rawItin)
  if (!normalized) {
    return {
      success: false,
      error: { code: "MISSING_ITIN_NUMBER", message: "ITIN number is required" },
      side_effects: [],
    }
  }
  if (!ITIN_FORMAT.test(normalized)) {
    return {
      success: false,
      error: {
        code: "INVALID_ITIN_FORMAT",
        message: `ITIN must be 9 digits starting with 9 (got '${rawItin}' — normalized to '${normalized}')`,
      },
      side_effects: [],
    }
  }

  const rawIssueDate = typeof params.itin_issue_date === "string" ? params.itin_issue_date.trim() : ""
  const issueDate = rawIssueDate || new Date().toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) {
    return {
      success: false,
      error: {
        code: "INVALID_ISSUE_DATE",
        message: `itin_issue_date must be ISO (YYYY-MM-DD), got '${rawIssueDate}'`,
      },
      side_effects: [],
    }
  }

  const rawLetterUrl =
    typeof params.irs_letter_drive_url === "string" ? params.irs_letter_drive_url.trim() : ""
  const letterFileId = rawLetterUrl ? parseDriveFileId(rawLetterUrl) : null

  if (ctx.mode === "preview") {
    return {
      success: true,
      side_effects: [
        {
          kind: "contact.field_preview",
          detail: `Would stamp contact.itin_number='${normalized}', itin_issue_date='${issueDate}'`,
        },
        ...(letterFileId
          ? [{ kind: "task_meta.letter_preview", detail: `IRS letter Drive file ID: ${letterFileId}` }]
          : []),
      ],
      preview: {
        portal_message: `Hi ${ctx.task.task_meta && typeof ctx.task.task_meta === "object" && typeof (ctx.task.task_meta as Record<string, unknown>).client_first_name === "string" ? (ctx.task.task_meta as { client_first_name: string }).client_first_name : "client"}, your ITIN ${normalized} has been issued. We'll deliver it via email and your portal next.`,
      },
    }
  }

  // Resolve contact_id: prefer task.contact_id; for account-only tasks, look up
  // the primary contact. ITINs SHOULD be contact-linked per project rule, so this
  // is mostly belt-and-suspenders.
  if (!ctx.task.contact_id) {
    return {
      success: false,
      error: {
        code: "NO_CONTACT",
        message: "Task has no contact_id — cannot stamp the ITIN on the contact's CRM record",
      },
      side_effects: [],
    }
  }

  const update = await updateContact({
    id: ctx.task.contact_id,
    patch: {
      itin_number: normalized,
      itin_issue_date: issueDate,
      itin: normalized,
    } as Parameters<typeof updateContact>[0]["patch"],
    actor: "workflow:itin.confirm_number_received",
    summary: `Stamped ITIN ${normalized} on contact (issued ${issueDate})`,
    details: { itin_number: normalized, itin_issue_date: issueDate },
  })

  if (!update.success) {
    return {
      success: false,
      error: { code: "CONTACT_UPDATE_FAILED", message: update.error ?? "updateContact returned success=false" },
      side_effects: [],
    }
  }

  return {
    success: true,
    side_effects: [
      {
        kind: "contact.itin_stamped",
        detail: `contacts.itin_number = '${normalized}' (issued ${issueDate})`,
        ref_id: ctx.task.contact_id,
      },
      ...(letterFileId
        ? [
            {
              kind: "task_meta.letter_recorded",
              detail: `IRS letter Drive file ID stored in task_meta`,
              ref_id: letterFileId,
            },
          ]
        : []),
    ],
    task_meta_patch: {
      itin_number: normalized,
      itin_issue_date: issueDate,
      ...(letterFileId ? { irs_letter_file_id: letterFileId, irs_letter_drive_url: rawLetterUrl } : {}),
    },
    result: {
      itin_number: normalized,
      itin_issue_date: issueDate,
      contact_id: ctx.task.contact_id,
      irs_letter_file_id: letterFileId,
    },
  }
}
