import { LayoutDashboard, FileText, Receipt, MessageCircle, Activity, Bell, User } from 'lucide-react'

const sections = [
  {
    icon: LayoutDashboard,
    title: 'Dashboard',
    description: 'Your main overview showing company information, active services with progress tracking, upcoming deadlines, payment history, and tax return status.',
  },
  {
    icon: FileText,
    title: 'Documents',
    description: 'Access all your company documents in one place. Download articles of organization, EIN letters, tax returns, and other important files. Filter by category to find what you need quickly.',
  },
  {
    icon: Receipt,
    title: 'Invoices',
    description: 'Create and send professional invoices to your customers in USD or EUR. Track payment status, send reminders, and download PDF copies. Set up recurring invoices for subscription-based services.',
  },
  {
    icon: Activity,
    title: 'Services',
    description: 'Track the progress of all services you have purchased, including LLC formation, EIN applications, tax returns, and more. See which step each service is on and whether anything is blocked.',
  },
  {
    icon: MessageCircle,
    title: 'Chat',
    description: 'Chat directly with the Tony Durante team. Messages are delivered in real-time. Use this for questions about your account, document requests, or any support needs.',
  },
  {
    icon: Bell,
    title: 'Notifications',
    description: 'Stay updated with notifications about your account. You will be notified when documents are uploaded, services change status, deadlines approach, and more.',
  },
  {
    icon: User,
    title: 'Profile',
    description: 'View your personal and company information. To update any details, contact the team via Chat.',
  },
]

export default function PortalGuidePage() {
  return (
    <div className="p-6 lg:p-8 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">How to Use the Portal</h1>
        <p className="text-zinc-500 text-sm mt-1">A quick guide to all portal features</p>
      </div>

      <div className="space-y-4">
        {sections.map((section) => (
          <div key={section.title} className="bg-white rounded-xl border shadow-sm p-5 flex gap-4">
            <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
              <section.icon className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-zinc-900 mb-1">{section.title}</h2>
              <p className="text-sm text-zinc-600 leading-relaxed">{section.description}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-blue-50 rounded-xl border border-blue-200 p-5 text-center">
        <p className="text-sm text-blue-800">
          Need help? Use the <strong>Chat</strong> section to reach our team directly.
        </p>
      </div>
    </div>
  )
}
