import { Eye } from 'lucide-react'

/**
 * Persistent read-only banner shown across the top of the portal while an admin
 * is viewing as a client. Server-rendered; the Exit link hits the GET exit route
 * that tears down the minted session. No interactivity needed beyond the link.
 */
export function ViewAsBanner({ clientName }: { clientName: string }) {
  return (
    <div className="sticky top-0 z-[100] flex items-center justify-center gap-3 bg-red-600 px-4 py-2 text-center text-sm font-medium text-white shadow-md">
      <Eye className="h-4 w-4 shrink-0" />
      <span>
        Viewing as <strong>{clientName}</strong> — <strong>READ ONLY</strong>. Actions are disabled.
      </span>
      <a
        href="/portal/view-as/exit"
        className="ml-2 shrink-0 rounded-md bg-white/20 px-3 py-1 font-semibold underline-offset-2 hover:bg-white/30"
      >
        Exit
      </a>
    </div>
  )
}
