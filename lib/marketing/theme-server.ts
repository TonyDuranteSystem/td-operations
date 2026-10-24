import { cookies } from "next/headers"
import { DEFAULT_THEME, THEME_COOKIE, parseTheme, type Theme } from "@/lib/marketing/theme"

/** The look this request is drawn in (server components). */
export function getTheme(): Theme {
  try { return parseTheme(cookies().get(THEME_COOKIE)?.value) } catch { return DEFAULT_THEME }
}
