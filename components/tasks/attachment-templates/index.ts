/**
 * Attachment template registry.
 *
 * Each catalog row's `attachment_template` field names one entry in this map.
 * The map is intentionally small — most workflows will reuse `pdf_list`.
 * New templates are added by:
 *   1. Writing the component under components/tasks/attachment-templates/<name>.tsx
 *   2. Adding the name → component entry below
 *   3. Updating the catalog row's `attachment_template` field
 *
 * Slice 3 ships only `pdf_list` (Slice 4 ITIN uses it). Slice 8/9 will add
 * `lease_preview`, `banking_form_summary`, `tax_summary`, `offer_summary`,
 * `formation_summary`, `closure_summary`, `8832_summary` as their workflows
 * land.
 *
 * `getAttachmentTemplate('unknown_name')` returns null — the WorkflowTaskCard
 * surfaces this as "Unknown attachment template" rather than crashing.
 */

import type { ComponentType } from 'react'
import { PdfListAttachment } from './pdf-list'

export interface AttachmentTemplateProps {
  taskMeta: Record<string, unknown> | null | undefined
}

const TEMPLATES: Record<string, ComponentType<AttachmentTemplateProps>> = {
  pdf_list: PdfListAttachment,
}

export function getAttachmentTemplate(
  name: string | null | undefined,
): ComponentType<AttachmentTemplateProps> | null {
  if (!name) return null
  return TEMPLATES[name] ?? null
}

/** All registered template names. For diagnostics + the exhaustiveness test. */
export function getRegisteredAttachmentTemplateNames(): string[] {
  return Object.keys(TEMPLATES)
}
