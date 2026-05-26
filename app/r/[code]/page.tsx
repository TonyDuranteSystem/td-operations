export const dynamic = "force-dynamic"

import Image from "next/image"
import { headers } from "next/headers"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { RefCookie } from "@/components/referral/ref-cookie"

const CALENDLY_URL = "https://calendly.com/antoniodurante/free-meet-greet-call"
const SITE_URL = "https://tonydurante.us"

// DRAFT copy — Antonio edits. Lives here for the visual draft; moves to i18n keys next.
const COPY = {
  en: {
    recommendedBy: (name: string) => `${name} recommended Tony Durante LLC`,
    recommendedGeneric: "You've been recommended to Tony Durante LLC",
    subtext:
      "We help entrepreneurs form and run U.S. LLCs — formation, banking, bookkeeping, and tax, handled end to end.",
    cta: "Book a free call",
    trust: "No obligation.",
  },
  it: {
    recommendedBy: (name: string) => `${name} ti ha consigliato Tony Durante LLC`,
    recommendedGeneric: "Sei stato consigliato a Tony Durante LLC",
    subtext:
      "Aiutiamo gli imprenditori a creare e gestire LLC americane — costituzione, conti bancari, contabilità e tasse, gestiti dall'inizio alla fine.",
    cta: "Prenota una call gratuita",
    trust: "Senza impegno.",
  },
} as const

function firstName(fullName: string | null | undefined): string | null {
  if (!fullName) return null
  const n = fullName.trim().split(/\s+/)[0]
  return n || null
}

export default async function ReferralLandingPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>
  searchParams: Promise<{ lang?: string; name?: string }>
}) {
  const { code } = await params
  const sp = await searchParams
  const lang = sp.lang === "it" ? "it" : "en"
  const c = COPY[lang]

  // Resolve referrer (preview override via ?name= for design review)
  let referrerFirst: string | null = sp.name ?? null
  let referrerContactId: string | null = null
  let validCode = false
  if (!referrerFirst) {
    const { data: contact } = await supabaseAdmin
      .from("contacts")
      .select("id, full_name, referral_code")
      .ilike("referral_code", code)
      .maybeSingle()
    if (contact) {
      validCode = true
      referrerContactId = contact.id
      referrerFirst = firstName(contact.full_name)
    }
  }

  // Log the click for real codes only (skip ?name= preview and unknown codes).
  // Fail-safe: logging must never break the page.
  if (validCode) {
    try {
      const h = await headers()
      await supabaseAdmin.from("referral_clicks").insert({
        referral_code: code,
        referrer_contact_id: referrerContactId,
        user_agent: h.get("user-agent"),
        referer: h.get("referer"),
      })
    } catch {
      /* swallow — analytics logging is best-effort */
    }
  }

  // Calendly link carries the code so it returns in the booking webhook
  const calendlyUrl = new URL(CALENDLY_URL)
  calendlyUrl.searchParams.set("utm_source", "referral")
  calendlyUrl.searchParams.set("utm_medium", "link")
  calendlyUrl.searchParams.set("utm_campaign", code)
  calendlyUrl.searchParams.set("a1", code) // hidden prefill fallback

  const headline = referrerFirst ? c.recommendedBy(referrerFirst) : c.recommendedGeneric

  return (
    <main className="min-h-screen bg-gradient-to-br from-violet-50 via-white to-indigo-50 flex items-center justify-center p-4">
      {validCode && <RefCookie code={code} />}
      <div className="w-full max-w-md bg-white rounded-2xl border border-zinc-200 shadow-xl p-8 sm:p-10 text-center">
        <Image
          src="/images/logo.jpg"
          alt="Tony Durante LLC"
          width={240}
          height={80}
          priority
          className="h-16 w-auto mx-auto rounded-lg mb-8"
        />

        <h1 className="text-2xl sm:text-[1.7rem] font-semibold tracking-tight text-zinc-900 leading-snug">
          {headline}
        </h1>

        <p className="text-zinc-500 text-sm sm:text-base mt-4 leading-relaxed">
          {c.subtext}
        </p>

        <a
          href={calendlyUrl.toString()}
          className="mt-8 inline-flex w-full items-center justify-center rounded-xl bg-violet-600 px-6 py-3.5 text-base font-medium text-white shadow-sm transition-colors hover:bg-violet-700"
        >
          {c.cta}
        </a>

        <p className="text-xs text-zinc-400 mt-4">{c.trust}</p>

        <a href={SITE_URL} className="block mt-8 text-xs text-zinc-400 hover:text-zinc-600">
          tonydurante.us
        </a>
      </div>
    </main>
  )
}
