'use client'

import { createContext, useContext } from 'react'

/**
 * The words of the TD Talk chat screen, as a swappable translator (dev job 9aec66fa). TD Talk and the CRM Team Chat render these components with NO provider, so they get the
 * default below — the English text exactly as written, with {slots} filled in — and nothing about them changes. The marketing lead chat wraps the same screen in a provider
 * that translates (Italian / English switch). Every word the screen shows goes through `t("English text")`, so a missing translation shows the English, never a blank.
 */
export type TalkT = (text: string, vars?: Record<string, string | number>) => string

export interface TalkI18n {
  t: TalkT
  /** Translates a line ONLY when it is one of the screen's own fixed lines ("Message deleted", "🎤 Voice message"…) — what a person wrote is never translated, even when it equals one of our words. */
  ts: (text: string) => string
  /** The heading above a day of messages: `label` is the English one the chat model made ("Today", "Wed, Oct 23"); `iso` is the day's first message. */
  day: (label: string, iso: string) => string
}

export const fillSlots: TalkT = (text, vars) => (vars ? text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : text)

/** The fixed lines the chat model writes when a message has no words (see snippet() in lib/talk/chat-model.ts). */
export const STATIC_SNIPPETS: ReadonlySet<string> = new Set(['Message deleted', 'Message', '🎤 Voice message', '📷 Photo'])

const DEFAULT: TalkI18n = { t: fillSlots, ts: text => text, day: label => label }
const Ctx = createContext<TalkI18n>(DEFAULT)

export const TalkI18nProvider = Ctx.Provider
export const useTalkI18n = (): TalkI18n => useContext(Ctx)
