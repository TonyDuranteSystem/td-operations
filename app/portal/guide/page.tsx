'use client'

import {
  MessageCircle, FileText, ChevronDown, Search, X, ArrowRight, Globe,
  CheckCircle2,
} from 'lucide-react'
import { useLocale } from '@/lib/portal/use-locale'
import { useState, useMemo, useCallback } from 'react'
import { cn } from '@/lib/utils'
import Link from 'next/link'
import { interpolateString } from '@/lib/template-interpolation'
import {
  ARTICLES_EN, ARTICLES_IT, GUIDE_CONTENT_EN, GUIDE_CONTENT_IT, RESULT_COUNT_TEMPLATE,
  type Article, type Content, type RoadmapItem,
} from './guide-content'

/**
 * Resolves this page's content for the current locale (dev job 12cab351).
 * English and Italian keep using the hand-written trees directly, same as
 * before this file was split — any OTHER picked language is resolved from
 * the dynamic translations map first, falling back to English. Same
 * two-tier "translations[en] ?? (locale === 'it' ? it : en)" pattern
 * already used for wizard field labels (components/portal/wizard/
 * wizard-field.tsx) — kept identical here rather than inventing a second
 * convention.
 */
function usePick(locale: string, translations: Record<string, string>) {
  return useCallback((en: string, it: string) => translations[en] ?? (locale === 'it' ? it : en), [locale, translations])
}

function resolveSearchResultCount(n: number, locale: string, translations: Record<string, string>): string {
  const dynamic = translations[RESULT_COUNT_TEMPLATE]
  if (dynamic) return interpolateString(dynamic, { n: String(n) })
  if (locale === 'it') return `${n} risultat${n === 1 ? 'o' : 'i'} trovat${n === 1 ? 'o' : 'i'}`
  return `${n} result${n === 1 ? '' : 's'} found`
}

const IT_ARTICLES_BY_ID = new Map(ARTICLES_IT.map(a => [a.id, a]))

function resolveArticles(pick: (en: string, it: string) => string): Article[] {
  return ARTICLES_EN.map(enArticle => {
    const itArticle = IT_ARTICLES_BY_ID.get(enArticle.id) ?? enArticle
    return {
      ...enArticle,
      section: pick(enArticle.section, itArticle.section),
      title: pick(enArticle.title, itArticle.title),
      desc: pick(enArticle.desc, itArticle.desc),
      steps: enArticle.steps.map((s, i) => {
        const itStep = itArticle.steps[i]
        return {
          text: pick(s.text, itStep?.text ?? s.text),
          sub: s.sub ? pick(s.sub, itStep?.sub ?? s.sub) : undefined,
        }
      }),
      tip: enArticle.tip ? pick(enArticle.tip, itArticle.tip ?? enArticle.tip) : undefined,
      link: enArticle.link
        ? { href: enArticle.link.href, label: pick(enArticle.link.label, itArticle.link?.label ?? enArticle.link.label) }
        : undefined,
    }
  })
}

function resolveContent(pick: (en: string, it: string) => string): Content {
  const en = GUIDE_CONTENT_EN
  const it = GUIDE_CONTENT_IT
  return {
    pageTitle: pick(en.pageTitle, it.pageTitle),
    pageSubtitle: pick(en.pageSubtitle, it.pageSubtitle),
    searchPlaceholder: pick(en.searchPlaceholder, it.searchPlaceholder),
    searchNoResults: pick(en.searchNoResults, it.searchNoResults),
    sections: en.sections.map((s, i) => pick(s, it.sections[i] ?? s)),
    articles: resolveArticles(pick),
    roadmapTitle: pick(en.roadmapTitle, it.roadmapTitle),
    roadmapItems: en.roadmapItems.map((item, i): RoadmapItem => {
      const itItem = it.roadmapItems[i]
      return {
        number: item.number,
        title: pick(item.title, itItem?.title ?? item.title),
        desc: pick(item.desc, itItem?.desc ?? item.desc),
      }
    }),
    helpTitle: pick(en.helpTitle, it.helpTitle),
    helpDesc: pick(en.helpDesc, it.helpDesc),
    chatBtn: pick(en.chatBtn, it.chatBtn),
  }
}

// ─── Roadmap Banner ───────────────────────────────────────────

function RoadmapBanner({ items, title }: { items: RoadmapItem[]; title: string }) {
  return (
    <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b bg-gradient-to-r from-blue-600 to-blue-700">
        <p className="text-sm font-semibold text-white">{title}</p>
      </div>
      <div className="divide-y">
        {items.map(item => (
          <div key={item.number} className="flex items-start gap-4 px-5 py-3">
            <div className="w-7 h-7 rounded-full bg-blue-100 text-blue-700 text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
              {item.number}
            </div>
            <div>
              <p className="text-sm font-semibold text-zinc-900">{item.title}</p>
              <p className="text-xs text-zinc-500 mt-0.5">{item.desc}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Article Component ────────────────────────────────────────

function ArticleCard({ article, defaultOpen }: { article: Article; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? false)

  return (
    <div className="bg-white rounded-xl border overflow-hidden shadow-sm">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 p-4 hover:bg-zinc-50 transition-colors text-left"
      >
        <div className={cn('w-9 h-9 rounded-lg flex items-center justify-center shrink-0', article.iconBg)}>
          <article.icon className={cn('h-4 w-4', article.iconColor)} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-zinc-900">{article.title}</p>
          <p className="text-xs text-zinc-500 mt-0.5 truncate">{article.desc}</p>
        </div>
        <ChevronDown className={cn('h-4 w-4 text-zinc-400 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="border-t px-4 pb-4 pt-3 space-y-3">
          <ol className="space-y-2">
            {article.steps.map((step, i) => (
              <li key={i} className="flex gap-3">
                <span className="w-5 h-5 rounded-full bg-blue-100 text-blue-700 text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
                  {i + 1}
                </span>
                <div>
                  <p className="text-sm text-zinc-700">{step.text}</p>
                  {step.sub && <p className="text-xs text-zinc-400 mt-0.5">{step.sub}</p>}
                </div>
              </li>
            ))}
          </ol>
          {article.tip && (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <CheckCircle2 className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-800">{article.tip}</p>
            </div>
          )}
          {article.link && (
            <Link
              href={article.link.href}
              className="inline-flex items-center gap-1.5 text-xs text-blue-600 font-medium hover:text-blue-700 mt-2"
            >
              <ArrowRight className="h-3.5 w-3.5" />
              {article.link.label}
            </Link>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Search Bar ───────────────────────────────────────────────

function SearchBar({ value, onChange, placeholder }: {
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full pl-9 pr-10 py-3 text-sm bg-white border rounded-xl shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
      />
      {value && (
        <button
          onClick={() => onChange('')}
          className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-zinc-100"
        >
          <X className="h-4 w-4 text-zinc-400" />
        </button>
      )}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────

export default function PortalGuidePage() {
  const { locale, t: translate, translations } = useLocale()
  const pick = usePick(locale, translations)
  const content = useMemo(() => resolveContent(pick), [pick])
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    if (!query.trim()) return null
    const q = query.toLowerCase()
    return content.articles.filter(a =>
      a.title.toLowerCase().includes(q) ||
      a.desc.toLowerCase().includes(q) ||
      a.keywords.some(k => k.toLowerCase().includes(q)) ||
      a.steps.some(s => s.text.toLowerCase().includes(q))
    )
  }, [query, content.articles])

  const groupedArticles = useMemo(() => {
    const groups: Record<string, Article[]> = {}
    for (const a of content.articles) {
      if (!groups[a.section]) groups[a.section] = []
      groups[a.section].push(a)
    }
    return groups
  }, [content.articles])

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">{content.pageTitle}</h1>
        <p className="text-zinc-500 text-sm mt-1">{content.pageSubtitle}</p>
      </div>

      {/* Search */}
      <SearchBar
        value={query}
        onChange={setQuery}
        placeholder={content.searchPlaceholder}
      />

      {/* Search results */}
      {filtered !== null && (
        <div className="space-y-3">
          {filtered.length > 0 ? (
            <>
              <p className="text-xs text-zinc-500">{resolveSearchResultCount(filtered.length, locale, translations)}</p>
              {filtered.map(a => <ArticleCard key={a.id} article={a} defaultOpen />)}
            </>
          ) : (
            <div className="bg-white rounded-xl border p-8 text-center">
              <Search className="h-8 w-8 text-zinc-300 mx-auto mb-2" />
              <p className="text-sm text-zinc-500">{content.searchNoResults}</p>
            </div>
          )}
        </div>
      )}

      {/* Grouped sections (when not searching) */}
      {filtered === null && (
        <>
          {/* Onboarding roadmap */}
          <RoadmapBanner items={content.roadmapItems} title={content.roadmapTitle} />

          {content.sections.map(section => {
            const articles = groupedArticles[section]
            if (!articles?.length) return null
            return (
              <div key={section} className="space-y-2">
                <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider px-1">{section}</h2>
                {articles.map(a => <ArticleCard key={a.id} article={a} />)}
              </div>
            )
          })}

          {/* Guides section */}
          <div className="space-y-2">
            <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider px-1">
              {translate('guide.stepByStepGuides')}
            </h2>
            {[
              {
                href: '/portal/guide/relay-wire',
                icon: Globe,
                color: 'bg-blue-50',
                iconColor: 'text-blue-600',
                title: translate('guide.relayWireTitle'),
                desc: translate('guide.relayWireDesc'),
              },
              {
                href: '/portal/guide/relay-docs',
                icon: FileText,
                color: 'bg-blue-50',
                iconColor: 'text-blue-600',
                title: translate('guide.relayDocsTitle'),
                desc: translate('guide.relayDocsDesc'),
              },
            ].map(g => (
              <Link
                key={g.href}
                href={g.href}
                className="flex items-center gap-3 bg-white rounded-xl border shadow-sm p-4 hover:bg-zinc-50 transition-colors"
              >
                <div className={cn('w-9 h-9 rounded-lg flex items-center justify-center shrink-0', g.color)}>
                  <g.icon className={cn('h-4 w-4', g.iconColor)} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-zinc-900">{g.title}</p>
                  <p className="text-xs text-zinc-500 mt-0.5">{g.desc}</p>
                </div>
                <ArrowRight className="h-4 w-4 text-zinc-400 shrink-0" />
              </Link>
            ))}
          </div>

          {/* Help Banner */}
          <div className="bg-gradient-to-r from-blue-600 to-blue-700 rounded-xl p-6 text-white text-center">
            <MessageCircle className="h-8 w-8 mx-auto mb-2 opacity-80" />
            <p className="text-sm font-semibold mb-1">{content.helpTitle}</p>
            <p className="text-xs opacity-80 mb-4">{content.helpDesc}</p>
            <Link
              href="/portal/chat"
              className="inline-flex items-center gap-2 px-4 py-2 bg-white text-blue-700 rounded-lg text-sm font-medium hover:bg-blue-50 transition-colors"
            >
              <MessageCircle className="h-4 w-4" />
              {content.chatBtn}
            </Link>
          </div>
        </>
      )}
    </div>
  )
}
