"use client"

import { useEffect, useState, useCallback } from "react"
import { FileText, CheckCircle, Clock, PenLine } from "lucide-react"
import { useRouter } from "next/navigation"

interface PortalSS4ClientProps {
  ss4Url: string
  status: string
  companyName: string
  language?: string
}

const STATUS_INFO: Record<string, { en: string; it: string; icon: typeof FileText; color: string; bg: string }> = {
  draft: { en: "SS-4 Ready for Signature", it: "SS-4 Pronto per la Firma", icon: PenLine, color: "text-blue-600", bg: "bg-blue-50" },
  awaiting_signature: { en: "Awaiting Your Signature", it: "In Attesa della Tua Firma", icon: Clock, color: "text-amber-600", bg: "bg-amber-50" },
  signed: { en: "Signed — Pending IRS Submission", it: "Firmato — In Attesa di Invio all'IRS", icon: CheckCircle, color: "text-green-600", bg: "bg-green-50" },
}

const SUBTITLES: Record<string, { en: string; it: string }> = {
  signed: { en: "Your SS-4 has been signed. We will fax it to the IRS.", it: "Il tuo SS-4 e stato firmato. Lo invieremo via fax all'IRS." },
  default: { en: "Review and sign your EIN application below.", it: "Rivedi e firma la tua richiesta EIN qui sotto." },
}

export function PortalSS4Client({ ss4Url, status, companyName, language }: PortalSS4ClientProps) {
  const router = useRouter()
  const [currentStatus, setCurrentStatus] = useState(status)

  const info = STATUS_INFO[currentStatus] || STATUS_INFO.draft
  const Icon = info.icon
  const lang = (language === "it" ? "it" : "en") as "en" | "it"
  const subtitle = SUBTITLES[currentStatus] || SUBTITLES.default

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
          <p className={`text-sm font-semibold ${info.color}`}>{info[lang]}</p>
          <p className="text-xs text-zinc-500">{subtitle[lang]}</p>
        </div>
      </div>

      {/* SS-4 iframe */}
      <iframe src={ss4Url} className="flex-1 w-full border-0" title={`SS-4 for ${companyName}`} allow="clipboard-write" />
    </div>
  )
}
