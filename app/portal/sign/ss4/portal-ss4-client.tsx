"use client"

import { useEffect, useState, useCallback } from "react"
import { FileText, CheckCircle, Clock, PenLine } from "lucide-react"
import { useRouter } from "next/navigation"
import { useLocale } from "@/lib/portal/use-locale"

interface PortalSS4ClientProps {
  ss4Url: string
  status: string
  companyName: string
}

const STATUS_ICON: Record<string, { key: string; icon: typeof FileText; color: string; bg: string }> = {
  draft: { key: "signSubpages.ss4.ready", icon: PenLine, color: "text-blue-600", bg: "bg-blue-50" },
  awaiting_signature: { key: "signSubpages.awaitingSignature", icon: Clock, color: "text-amber-600", bg: "bg-amber-50" },
  signed: { key: "signSubpages.signedPendingIRS", icon: CheckCircle, color: "text-green-600", bg: "bg-green-50" },
}

export function PortalSS4Client({ ss4Url, status, companyName }: PortalSS4ClientProps) {
  const router = useRouter()
  const { t } = useLocale()
  const [currentStatus, setCurrentStatus] = useState(status)

  const info = STATUS_ICON[currentStatus] || STATUS_ICON.draft
  const Icon = info.icon
  const subtitle = currentStatus === "signed" ? t("signSubpages.ss4.subtitleSigned") : t("signSubpages.ss4.subtitleDefault")

  // Listen for postMessage from embedded SS-4 page when signing completes
  const handleMessage = useCallback(
    (event: MessageEvent) => {
      if (event.data?.type === "ss4-signed") {
        setCurrentStatus("signed")
        setTimeout(() => router.refresh(), 1500)
      }
    },
    [router]
  )

  useEffect(() => {
    window.addEventListener("message", handleMessage)
    return () => window.removeEventListener("message", handleMessage)
  }, [handleMessage])

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Status bar */}
      <div className={`${info.bg} border-b px-6 py-3 flex items-center gap-3`}>
        <Icon className={`h-5 w-5 ${info.color}`} />
        <div>
          <p className={`text-sm font-semibold ${info.color}`}>{t(info.key)}</p>
          <p className="text-xs text-zinc-500">{subtitle}</p>
        </div>
      </div>

      {/* SS-4 iframe */}
      <iframe src={ss4Url} className="flex-1 w-full border-0" title={`SS-4 for ${companyName}`} allow="clipboard-write" />
    </div>
  )
}
