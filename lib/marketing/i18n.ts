/**
 * Italian for the TD Marketing workspace (pure; dev job 9aec66fa — Antonio, 2026-10-23: "make the system in Italian as well"). English is the source text: the screens write
 * `t("Call list")` and the Italian is looked up by that exact English text in `i18n-it.ts`. A text with a value uses {name} slots: `t("{n} to call", { n: 3 })`.
 * A text that is not in the Italian list is shown in English (never blank, never an error) — and a unit test fails the build while any `t("…")` in the screens has no Italian,
 * so nothing is left half-translated by accident.
 */
import type { Lang } from "@/lib/marketing/templates"
import { IT } from "@/lib/marketing/i18n-it"

export type TFn = (text: string, vars?: Record<string, string | number>) => string

const fill = (s: string, vars?: Record<string, string | number>): string => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s)

export function makeT(lang: Lang): TFn {
  return (text, vars) => fill(lang === "it" ? (IT[text] ?? text) : text, vars)
}

/** Locale for dates and numbers. */
export const localeFor = (lang: Lang): string => (lang === "it" ? "it-IT" : "en-GB")

/** "Setter + Seller, 2 changes" / "Custom access" in the person's language (the pieces are the role names `accessLabel` builds it from). */
export function tAccessLabel(t: TFn, label: string): string {
  const m = /^(.*?)(?:, (\d+) changes?)?$/.exec(label)
  const base = (m?.[1] ?? label).split(" + ").map(x => t(x)).join(" + ")
  const n = m?.[2] ? Number(m[2]) : 0
  return n > 0 ? `${base}, ${t(n === 1 ? "{n} change" : "{n} changes", { n })}` : base
}
