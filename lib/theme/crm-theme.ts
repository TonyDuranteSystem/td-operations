// CRM theme preference (Light / Dark / Auto). Dashboard only — the client portal, public offer / lease / sign
// pages and TD Talk never get the `crm-dark` class, so they always stay light.

export type ThemePref = 'light' | 'dark' | 'auto'

export const THEME_STORAGE_KEY = 'td-theme'
export const THEME_CLASS = 'crm-dark'
export const THEME_CHANGE_EVENT = 'td-theme-change'

/** Anything unrecognised (missing, tampered, old) means "follow the system". */
export function normalizeThemePref(raw: string | null | undefined): ThemePref {
  return raw === 'light' || raw === 'dark' ? raw : 'auto'
}

export function resolveIsDark(pref: ThemePref, systemPrefersDark: boolean): boolean {
  if (pref === 'dark') return true
  if (pref === 'light') return false
  return systemPrefersDark
}

/** Auto -> Light -> Dark -> Auto, for the one-tap sidebar button. */
export function nextThemePref(pref: ThemePref): ThemePref {
  return pref === 'auto' ? 'light' : pref === 'light' ? 'dark' : 'auto'
}

/**
 * Runs before the first paint (inline in the dashboard layout) so there is no white flash, and inside every
 * floating-window frame, which is its own document and does not inherit the parent's <html> class.
 * Self-contained on purpose: it is serialised into the page, so it cannot reference anything above.
 */
export const THEME_PRE_PAINT_SCRIPT = `(function(){try{var p=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});var d=p==='dark'||(p!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(d)document.documentElement.classList.add(${JSON.stringify(
  THEME_CLASS,
)})}catch(e){}})();`
