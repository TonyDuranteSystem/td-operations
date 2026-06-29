/**
 * TD Communication — landing page content data layer (server-side).
 *
 * Stored as ONE jsonb blob in app_settings under 'td_communication_landing'
 * (no dedicated table — same pattern as comm-settings.ts). Two snapshots:
 *   - draft     — the editor workspace (autosaved)
 *   - published — what portal clients actually see
 * Publish promotes draft → published. The portal page reads getPublishedLanding;
 * the editor reads getLandingEditorState.
 *
 * Server-only (getAppSetting/setAppSetting use supabaseAdmin). Pure logic lives
 * in landing-content.ts so it's client-safe + unit-testable without the DB.
 */

import { getAppSetting, setAppSetting } from '@/lib/settings'
import { listPackages } from './packages-queries'
import {
  DEFAULT_LANDING_CONTENT,
  validateLandingContent,
  landingContentEqual,
} from './landing-content'
import type {
  LandingContent,
  TdCommLandingState,
  LandingEditorState,
  TdCommPackage,
} from './types'

export const TD_COMM_LANDING_KEY = 'td_communication_landing' as const

/** Layer a stored (possibly partial) blob over defaults; both snapshots validated. */
function mergeState(stored: Partial<TdCommLandingState> | null | undefined): TdCommLandingState {
  const s = stored ?? {}
  return {
    draft: validateLandingContent(s.draft),
    published: validateLandingContent(s.published),
    published_at: typeof s.published_at === 'string' ? s.published_at : null,
    published_by: typeof s.published_by === 'string' ? s.published_by : null,
    updated_at: typeof s.updated_at === 'string' ? s.updated_at : null,
    updated_by: typeof s.updated_by === 'string' ? s.updated_by : null,
  }
}

/** Full stored state (defaults merged under any stored value). */
export async function getLandingState(): Promise<TdCommLandingState> {
  const stored = await getAppSetting<Partial<TdCommLandingState>>(TD_COMM_LANDING_KEY, {})
  return mergeState(stored)
}

/** Editor view: both snapshots + whether the draft differs from published. */
export async function getLandingEditorState(): Promise<LandingEditorState> {
  const state = await getLandingState()
  return { ...state, hasUnpublishedChanges: !landingContentEqual(state.draft, state.published) }
}

/** Published content only — what the portal renders. */
export async function getPublishedLanding(): Promise<LandingContent> {
  const state = await getLandingState()
  return state.published
}

/** Persist the draft (autosave / Save draft). Does NOT touch published. */
export async function saveDraft(content: Partial<LandingContent>, editorName: string): Promise<LandingEditorState> {
  const current = await getLandingState()
  const draft = validateLandingContent(content)
  const next: TdCommLandingState = {
    ...current,
    draft,
    updated_at: new Date().toISOString(),
    updated_by: editorName || current.updated_by,
  }
  await setAppSetting(TD_COMM_LANDING_KEY, next)
  return { ...next, hasUnpublishedChanges: !landingContentEqual(next.draft, next.published) }
}

/** Promote draft → published (go live with the current draft). */
export async function publishDraft(editorName: string): Promise<LandingEditorState> {
  const current = await getLandingState()
  const now = new Date().toISOString()
  const next: TdCommLandingState = {
    draft: current.draft,
    published: current.draft, // copy
    published_at: now,
    published_by: editorName || current.published_by,
    updated_at: now,
    updated_by: editorName || current.updated_by,
  }
  await setAppSetting(TD_COMM_LANDING_KEY, next)
  return { ...next, hasUnpublishedChanges: false }
}

/** Discard unpublished changes — revert the draft back to the published snapshot. */
export async function discardDraft(editorName: string): Promise<LandingEditorState> {
  const current = await getLandingState()
  const next: TdCommLandingState = {
    ...current,
    draft: current.published,
    updated_at: new Date().toISOString(),
    updated_by: editorName || current.updated_by,
  }
  await setAppSetting(TD_COMM_LANDING_KEY, next)
  return { ...next, hasUnpublishedChanges: false }
}

/**
 * Active packages for the landing page packages grid. Defensive: returns [] on
 * any error or missing table so the public page never breaks (the td_comm_packages
 * table may not exist in every environment yet).
 */
export async function listLandingPackages(): Promise<TdCommPackage[]> {
  try {
    return await listPackages({})
  } catch {
    return []
  }
}

export { DEFAULT_LANDING_CONTENT }
