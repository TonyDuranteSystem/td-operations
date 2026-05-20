import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isAdmin, isDashboardUser } from '@/lib/auth'
import {
  Activity,
  AlertTriangle,
  HeartPulse,
  Rocket,
  Settings,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

interface ToolTile {
  name: string
  href: string
  description: string
  icon: LucideIcon
  adminOnly?: boolean
}

// The operator tools, gathered out of the main sidebar into one hub.
const TOOLS: ToolTile[] = [
  {
    name: 'System Health',
    href: '/system-health',
    description: 'Live system visibility — crons, audit findings, deploys, work locks, stuck clients.',
    icon: Activity,
    adminOnly: true,
  },
  {
    name: 'Exceptions',
    href: '/exceptions',
    description: 'What is broken right now — partial activations, audit findings, failed jobs and emails, webhook events awaiting review.',
    icon: AlertTriangle,
    adminOnly: true,
  },
  {
    name: 'Client Health',
    href: '/client-health',
    description: 'Stuck activations, orphan records, wrong account types, and data integrity issues.',
    icon: HeartPulse,
  },
  {
    name: 'Portal Launch',
    href: '/portal-launch',
    description: 'Client portal management — create portal users, send invitations.',
    icon: Rocket,
  },
  {
    name: 'Config',
    href: '/config',
    description: 'Edit SOPs, pipeline stages, and dev tasks through a guarded surface instead of raw SQL.',
    icon: Settings,
    adminOnly: true,
  },
  {
    name: 'Dev Tools',
    href: '/dev-tools',
    description: 'Developer utilities — database queries, system status, and debugging tools.',
    icon: Wrench,
    adminOnly: true,
  },
]

export default async function ToolsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!isDashboardUser(user)) {
    redirect('/')
  }
  const admin = isAdmin(user)

  const visible = TOOLS.filter(t => !t.adminOnly || admin)

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Tools</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Operator tools — system health, exceptions, client health, config, and more.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {visible.map(tool => {
          const Icon = tool.icon
          return (
            <Link
              key={tool.href}
              href={tool.href}
              className="group rounded-lg border bg-white p-5 hover:border-blue-300 hover:shadow-sm transition-all"
            >
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-lg bg-zinc-100 group-hover:bg-blue-50 flex items-center justify-center shrink-0 transition-colors">
                  <Icon className="h-5 w-5 text-zinc-600 group-hover:text-blue-600 transition-colors" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-zinc-800 group-hover:text-blue-700 transition-colors">
                    {tool.name}
                  </h2>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    {tool.description}
                  </p>
                </div>
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
