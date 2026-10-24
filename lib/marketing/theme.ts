/**
 * The look a person works in: light, dark, or follow the computer (TD Marketing, dev job 9aec66fa). Kept in a cookie on that person's own browser, read on the server so the page is
 * drawn in the right look from the first moment (no flash). Default = follow the computer.
 */
export const THEME_COOKIE = "tdm_theme"
export type Theme = "light" | "dark" | "system"
export const THEMES: readonly Theme[] = ["light", "dark", "system"]
export const DEFAULT_THEME: Theme = "system"
export const parseTheme = (v: unknown): Theme => (THEMES as readonly string[]).includes(v as string) ? (v as Theme) : DEFAULT_THEME
/** the message the workspace sends to the lead windows (frames) when the person changes the look */
export const THEME_MESSAGE = "tdm-theme"
