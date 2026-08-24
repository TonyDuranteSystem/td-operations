'use client'

import { ArrowLeft, FileText, CheckCircle, ChevronRight, Info, MessageCircle, FolderOpen } from 'lucide-react'
import Link from 'next/link'
import { useLocale } from '@/lib/portal/use-locale'

// Builds the step list from the shared dictionary — kept as a function (not a
// module-level constant) since it must re-resolve whenever the caller's t()
// (locale + loaded translations) changes.
const buildSteps = (t: (key: string) => string) => [
  {
    title: t('guideRelayDocs.steps.0.title'),
    desc: t('guideRelayDocs.steps.0.desc'),
  },
  {
    title: t('guideRelayDocs.steps.1.title'),
    desc: t('guideRelayDocs.steps.1.desc'),
  },
  {
    title: t('guideRelayDocs.steps.2.title'),
    desc: t('guideRelayDocs.steps.2.desc'),
  },
  {
    title: t('guideRelayDocs.steps.3.title'),
    desc: t('guideRelayDocs.steps.3.desc'),
    items: [t('guideRelayDocs.steps.3.items.0'), t('guideRelayDocs.steps.3.items.1'), t('guideRelayDocs.steps.3.items.2'), t('guideRelayDocs.steps.3.items.3'), t('guideRelayDocs.steps.3.items.4')],
  },
  {
    title: t('guideRelayDocs.steps.4.title'),
    desc: t('guideRelayDocs.steps.4.desc'),
    portalNote: t('guideRelayDocs.steps.4.portalNote'),
  },
  {
    title: t('guideRelayDocs.steps.5.title'),
    desc: t('guideRelayDocs.steps.5.desc'),
    portalNote: t('guideRelayDocs.steps.5.portalNote'),
  },
  {
    title: t('guideRelayDocs.steps.6.title'),
    desc: t('guideRelayDocs.steps.6.desc'),
  },
]

export default function RelayDocsGuidePage() {
  const { t } = useLocale()

  const back = t('guideRelayDocs.back')
  const title = t('guideRelayDocs.title')
  const subtitle = t('guideRelayDocs.subtitle')
  const needTitle = t('guideRelayDocs.needTitle')
  const needItems = [0, 1, 2, 3, 4, 5, 6].map(i => t(`guideRelayDocs.needItems.${i}`))
  const stepsHeading = t('guideRelayDocs.stepsHeading')
  const steps = buildSteps(t)
  const tipsTitle = t('guideRelayDocs.tipsTitle')
  const tips = [0, 1, 2, 3].map(i => t(`guideRelayDocs.tips.${i}`))
  const helpTitle = t('guideRelayDocs.helpTitle')
  const helpDesc = t('guideRelayDocs.helpDesc')
  const chatBtn = t('guideRelayDocs.chatBtn')

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-3xl mx-auto space-y-8">

      {/* Back link */}
      <Link
        href="/portal/guide"
        className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-900 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        {back}
      </Link>

      {/* Header */}
      <div className="flex items-center gap-4">
        <div className="w-12 h-12 rounded-xl bg-blue-50 flex items-center justify-center shrink-0">
          <FileText className="h-6 w-6 text-blue-600" />
        </div>
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">
            {title}
          </h1>
          <p className="text-zinc-500 text-sm mt-0.5">
            {subtitle}
          </p>
        </div>
      </div>

      {/* What you need */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-5">
        <p className="text-sm font-semibold text-amber-800 mb-3">{needTitle}</p>
        <ul className="space-y-2">
          {needItems.map((item, i) => (
            <li key={i} className="flex items-center gap-2.5 text-sm text-amber-700">
              <CheckCircle className="h-4 w-4 shrink-0" />
              {item}
            </li>
          ))}
        </ul>
      </div>

      {/* Steps */}
      <div className="space-y-4">
        <h2 className="text-base font-semibold">{stepsHeading}</h2>
        {steps.map((step, i) => (
          <div key={i} className="bg-white rounded-xl border p-5">
            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full bg-blue-600 text-white text-sm font-bold flex items-center justify-center shrink-0 mt-0.5">
                {i + 1}
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-zinc-900 mb-1">{step.title}</p>
                <p className="text-sm text-zinc-500 leading-relaxed">{step.desc}</p>
                {step.items && (
                  <ul className="mt-3 space-y-1.5">
                    {step.items.map((item, j) => (
                      <li key={j} className="flex items-center gap-2 text-sm text-zinc-600">
                        <ChevronRight className="h-4 w-4 text-blue-400 shrink-0" />
                        {item}
                      </li>
                    ))}
                  </ul>
                )}
                {step.portalNote && (
                  <div className="mt-3 flex items-center gap-2 text-xs text-blue-700 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
                    <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                    {step.portalNote}
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Tips */}
      <div className="bg-blue-50 border border-blue-100 rounded-xl p-5">
        <div className="flex items-start gap-3">
          <Info className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-blue-800 mb-2">{tipsTitle}</p>
            <ul className="space-y-1.5">
              {tips.map((tip, i) => (
                <li key={i} className="text-sm text-blue-700 leading-relaxed">{tip}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* Help */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 rounded-xl p-6 text-white text-center">
        <MessageCircle className="h-8 w-8 mx-auto mb-2 opacity-80" />
        <p className="text-sm font-semibold mb-1">{helpTitle}</p>
        <p className="text-xs opacity-80 mb-4">{helpDesc}</p>
        <Link
          href="/portal/chat"
          className="inline-flex items-center gap-2 px-4 py-2 bg-white text-blue-700 rounded-lg text-sm font-medium hover:bg-blue-50 transition-colors"
        >
          <MessageCircle className="h-4 w-4" />
          {chatBtn}
        </Link>
      </div>

    </div>
  )
}
