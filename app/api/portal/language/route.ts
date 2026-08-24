import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { NextRequest, NextResponse } from 'next/server'
import { isValidLanguageCode, languageName } from '@/lib/portal/language-codes'
import { checkRateLimit, getRateLimitKey } from '@/lib/portal/rate-limit'
import { SUPPORTED_LOCALES, getEnglishDictionary } from '@/lib/portal/i18n'
import { seedPendingTranslations } from '@/lib/portal/translation-generator'
import { getWizardTranslatableText } from '@/lib/portal/wizard-translatable-text'
import { getGuideTranslatableText } from '@/lib/portal/guide-translatable-text'
import { isBrandNewLanguage, distinctLanguagesTranslatedToday, MAX_NEW_LANGUAGES_PER_DAY } from '@/lib/portal/language-cap'
import { enqueueJob } from '@/lib/jobs/queue'

type TranslationSource = 'dictionary' | 'wizard' | 'guide'

// Same order the job handler's own chain hops through (translate-language.ts's
// NEXT_SOURCE) — dictionary, then wizard, then the guide/help-article library.
const SOURCES_IN_ORDER: Array<{ source: TranslationSource; dictionary: () => Record<string, string> }> = [
  { source: 'dictionary', dictionary: getEnglishDictionary },
  { source: 'wizard', dictionary: getWizardTranslatableText },
  { source: 'guide', dictionary: getGuideTranslatableText },
]

/**
 * The job handler's own chain-continuation dedup only guards chunk-to-chunk
 * within an already-running chain — it never protected this initial enqueue.
 * Two clients (or two devices/tabs for the same client) picking the same
 * never-before-seen language at once could each start their own chunk-0 job
 * for it (found in review, 2026-08-23). Per-key claiming inside the job still
 * prevents double-translating any single entry, but this avoids the wasted
 * duplicate job outright.
 */
async function hasLiveTranslateJob(languageCode: string, source: TranslationSource): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('job_queue')
    .select('id')
    .eq('job_type', 'translate_language')
    .eq('payload->>language_code', languageCode)
    .eq('payload->>source', source)
    .in('status', ['pending', 'processing'])
    .limit(1)
  return !!data && data.length > 0
}

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Picking a never-before-offered language can trigger a real, paid
  // AI-translation batch — this is an open ISO-639-1 list rather than a
  // 2-value enum, so it needs its own abuse guard rather than relying on a
  // tiny enum to make abuse pointless.
  const rateLimitKey = getRateLimitKey(request) + `:${user.id}`
  const { allowed, retryAfter } = checkRateLimit(rateLimitKey, 10, 60_000)
  if (!allowed) {
    return NextResponse.json({ error: 'Too many language changes — please wait a moment and try again.' }, { status: 429, headers: retryAfter ? { 'Retry-After': String(retryAfter) } : undefined })
  }

  const body = await request.json()
  const { language } = body

  if (!language || typeof language !== 'string' || !isValidLanguageCode(language)) {
    return NextResponse.json({ error: 'Not a recognized language.' }, { status: 400 })
  }
  const lang = language.toLowerCase()

  const { error } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
    user_metadata: {
      ...user.user_metadata,
      portal_language: lang,
    },
  })

  if (error) {
    return NextResponse.json({ error: 'Failed to update language preference' }, { status: 500 })
  }

  // Any locale outside the fully-hand-written set may need real translation
  // work. Seeding is fast and insert-only (dev job 12cab351) — safe to do
  // inline; the actual AI-calling work always happens in the background job,
  // never in this request.
  if (!(SUPPORTED_LOCALES as readonly string[]).includes(lang)) {
    try {
      const brandNew = await isBrandNewLanguage(lang)
      if (brandNew && (await distinctLanguagesTranslatedToday()) >= MAX_NEW_LANGUAGES_PER_DAY) {
        // Daily ceiling on brand-new languages reached. The preference is
        // still saved above (never block someone from choosing their own
        // language) — it just won't start translating until the window
        // rolls over or an existing language's own top-up work triggers it.
        console.warn(`[portal/language] daily new-language cap (${MAX_NEW_LANGUAGES_PER_DAY}) reached — skipping translation kickoff for "${lang}"`)
      } else {
        // Seed+enqueue the FIRST source (in chain order) that still has
        // missing work. A returning language whose dictionary (and maybe
        // wizard) content is already fully translated only needs whichever
        // source is genuinely behind — e.g. the help-article library, which
        // lags behind on its own separate track.
        for (const { source, dictionary } of SOURCES_IN_ORDER) {
          const seeded = await seedPendingTranslations(lang, dictionary())
          if (seeded.missing > 0) {
            if (!(await hasLiveTranslateJob(lang, source))) {
              await enqueueJob({
                job_type: 'translate_language',
                payload: { language_code: lang, language_name: languageName(lang) ?? lang, source, chunk_index: 0, auto_retry: 0 },
                created_by: 'portal-language-picker',
              })
            }
            break
          }
        }
      }
    } catch (e) {
      // Never fail the language switch itself over a translation-kickoff
      // hiccup — the client's chosen language is already saved above, and
      // everything just falls back to English until this is retried.
      console.error('[portal/language] translation kickoff failed (preference still saved):', e)
    }
  }

  return NextResponse.json({ success: true })
}
