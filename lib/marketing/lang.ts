/**
 * The language a person works in (server; TD Marketing, dev job 9aec66fa). Kept in a cookie on that person's own browser (nothing in the database), default Italian: the
 * team works in Italian. The menu switch sets it (`/api/marketing/lang`).
 */
import { cookies } from "next/headers"
import type { Lang } from "@/lib/marketing/templates"
import { makeT, type TFn } from "@/lib/marketing/i18n"

export const LANG_COOKIE = "tdm_lang"
export const DEFAULT_LANG: Lang = "it"
export const parseLang = (v: unknown): Lang => (v === "en" ? "en" : v === "it" ? "it" : DEFAULT_LANG)

export function getLang(): Lang {
  try { return parseLang(cookies().get(LANG_COOKIE)?.value) } catch { return DEFAULT_LANG }
}

/** The translator for this request (server components). */
export function getT(): TFn { return makeT(getLang()) }
