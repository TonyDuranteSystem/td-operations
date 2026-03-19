'use client'

import { LayoutDashboard, FileText, Receipt, MessageCircle, Activity, Bell, User } from 'lucide-react'
import { useLocale } from '@/lib/portal/use-locale'

export default function PortalGuidePage() {
  const { t } = useLocale()

  const sections = [
    { icon: LayoutDashboard, titleKey: 'guide.dashboardTitle', descKey: 'guide.dashboardDesc' },
    { icon: FileText, titleKey: 'guide.documentsTitle', descKey: 'guide.documentsDesc' },
    { icon: Receipt, titleKey: 'guide.invoicesTitle', descKey: 'guide.invoicesDesc' },
    { icon: Activity, titleKey: 'guide.servicesTitle', descKey: 'guide.servicesDesc' },
    { icon: MessageCircle, titleKey: 'guide.chatTitle', descKey: 'guide.chatDesc' },
    { icon: Bell, titleKey: 'guide.notificationsTitle', descKey: 'guide.notificationsDesc' },
  ]

  return (
    <div className="p-6 lg:p-8 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">{t('guide.title')}</h1>
        <p className="text-zinc-500 text-sm mt-1">{t('guide.subtitle')}</p>
      </div>

      <div className="space-y-4">
        {sections.map((section) => (
          <div key={section.titleKey} className="bg-white rounded-xl border shadow-sm p-5 flex gap-4">
            <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
              <section.icon className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-zinc-900 mb-1">{t(section.titleKey)}</h2>
              <p className="text-sm text-zinc-600 leading-relaxed">{t(section.descKey)}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-blue-50 rounded-xl border border-blue-200 p-5 text-center">
        <p className="text-sm text-blue-800">{t('guide.help')}</p>
      </div>
    </div>
  )
}
