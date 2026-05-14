/**
 * Central registry for all portal-viewable forms.
 *
 * Adding a new form type:
 *   1. Create components/forms/<type>-form.tsx  (embedded + adminMode props)
 *   2. Create app/<publicPath>/[token]/[access_code]/page.tsx  (thin wrapper)
 *   3. Add ONE entry to FORM_REGISTRY below — lookup API and URL helpers
 *      pick it up automatically.
 *   4. Add ONE dynamic() line to app/portal/form/[token]/[access_code]/page.tsx
 *      so the portal viewer can render it.
 *
 * Only register forms whose Supabase table has `token` and `access_code`
 * columns — the generic lookup API filters on both.
 */

export interface FormDefinition {
  /** Identifier returned by the lookup API and used in the portal viewer */
  form_type: string
  /** Supabase table that stores the form record (must have token + access_code) */
  table: string
  /** URL path segment on app.tonydurante.us, e.g. "member-info" */
  publicPath: string
}

export const FORM_REGISTRY: FormDefinition[] = [
  {
    form_type: 'contact_request',
    table: 'contact_request_forms',
    publicPath: 'contact-request',
  },
  {
    form_type: 'member_info',
    table: 'member_info_requests',
    publicPath: 'member-info',
  },
]

/** O(1) lookup by form_type. Returns undefined for unregistered types. */
export const FORM_BY_TYPE: Partial<Record<string, FormDefinition>> =
  Object.fromEntries(FORM_REGISTRY.map(f => [f.form_type, f]))

/** O(1) lookup by table name. Returns undefined for unregistered tables. */
export const FORM_BY_TABLE: Partial<Record<string, FormDefinition>> =
  Object.fromEntries(FORM_REGISTRY.map(f => [f.table, f]))
