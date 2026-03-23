import { createClient } from '@/lib/supabase/server'
import { TaskKanban } from '@/components/tasks/task-kanban'
import type { Task, TaskStats } from '@/lib/types'

export interface ServiceTab {
  key: string
  label: string
  count: number
  overdue: number
  dueSoon: number
  health: 'green' | 'orange' | 'red'
}

export default async function TasksPage() {
  const supabase = createClient()
  const today = new Date().toISOString().split('T')[0]
  const sevenDaysFromNow = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0]

  // Fetch active tasks with delivery info
  const { data: activeTasks } = await supabase
    .from('tasks')
    .select('id, task_title, status, priority, due_date, assigned_to, category, description, account_id, delivery_id, updated_at, created_at')
    .in('status', ['To Do', 'In Progress', 'Waiting'])
    .order('due_date', { ascending: true, nullsFirst: false })

  // Fetch recent Done tasks (limit 50)
  const { data: doneTasks } = await supabase
    .from('tasks')
    .select('id, task_title, status, priority, due_date, assigned_to, category, description, account_id, delivery_id, updated_at, created_at')
    .eq('status', 'Done')
    .order('updated_at', { ascending: false })
    .limit(50)

  const rawTasks = [...(activeTasks ?? []), ...(doneTasks ?? [])]

  // Fetch company names for tasks with account_id
  const accountIds = Array.from(new Set(rawTasks.filter(t => t.account_id).map(t => t.account_id)))
  let accountMap: Record<string, string> = {}
  if (accountIds.length > 0) {
    const { data: accounts } = await supabase
      .from('accounts')
      .select('id, company_name')
      .in('id', accountIds)
    if (accounts) {
      accountMap = Object.fromEntries(accounts.map(a => [a.id, a.company_name]))
    }
  }

  // Fetch service delivery info for tasks with delivery_id
  const deliveryIds = Array.from(new Set(rawTasks.filter(t => t.delivery_id).map(t => t.delivery_id)))
  let deliveryMap: Record<string, string> = {} // delivery_id → service_type
  if (deliveryIds.length > 0) {
    const { data: deliveries } = await supabase
      .from('service_deliveries')
      .select('id, service_type')
      .in('id', deliveryIds)
    if (deliveries) {
      deliveryMap = Object.fromEntries(deliveries.map(d => [d.id, d.service_type]))
    }
  }

  const tasks: Task[] = rawTasks.map(t => ({
    ...t,
    company_name: t.account_id ? accountMap[t.account_id] ?? null : null,
    service_type: t.delivery_id ? deliveryMap[t.delivery_id] ?? null : null,
  }))

  // Build service tabs from active tasks
  const activeTasks2 = tasks.filter(t => t.status !== 'Done')
  const serviceGroups = new Map<string, Task[]>()
  for (const t of activeTasks2) {
    const key = t.service_type || 'General'
    if (!serviceGroups.has(key)) serviceGroups.set(key, [])
    serviceGroups.get(key)!.push(t)
  }

  // Define tab order (most important first)
  const TAB_ORDER = ['Company Formation', 'Client Onboarding', 'ITIN', 'Tax Return', 'EIN', 'Banking Fintech', 'Annual Renewal', 'CMRA Mailing Address', 'State RA Renewal', 'State Annual Report', 'General']

  const serviceTabs: ServiceTab[] = TAB_ORDER
    .filter(key => serviceGroups.has(key))
    .map(key => {
      const group = serviceGroups.get(key)!
      const overdue = group.filter(t => t.due_date && t.due_date < today).length
      const dueSoon = group.filter(t => t.due_date && t.due_date >= today && t.due_date <= sevenDaysFromNow).length
      const health: 'green' | 'orange' | 'red' = overdue > 0 ? 'red' : dueSoon > 0 ? 'orange' : 'green'
      return { key, label: key, count: group.length, overdue, dueSoon, health }
    })

  // Stats (active tasks only, exclude Done)
  const isOverdue = (t: Task) => t.due_date !== null && t.due_date < today

  const stats: TaskStats = {
    total: activeTasks2.length,
    urgent: activeTasks2.filter(t => t.priority === 'Urgent' || isOverdue(t)).length,
    waiting: activeTasks2.filter(t => t.status === 'Waiting').length,
    overdue: activeTasks2.filter(t => isOverdue(t)).length,
    inProgress: activeTasks2.filter(t => t.status === 'In Progress').length,
  }

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Task Board</h1>
        <p className="text-muted-foreground text-sm mt-1">Daily operational task overview</p>
      </div>
      <TaskKanban tasks={tasks} stats={stats} today={today} serviceTabs={serviceTabs} />
    </div>
  )
}
