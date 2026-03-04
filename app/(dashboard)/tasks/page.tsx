import { createClient } from '@/lib/supabase/server'
import { TaskBoard } from '@/components/tasks/task-board'
import type { Task, TaskStats, GroupedTasks } from '@/lib/types'

export default async function TasksPage() {
  const supabase = createClient()
  const today = new Date().toISOString().split('T')[0]

  const { data: rawTasks } = await supabase
    .from('tasks')
    .select('id, task_title, status, priority, due_date, assigned_to, category, description, account_id, updated_at, created_at')
    .in('status', ['To Do', 'In Progress', 'Waiting'])
    .order('due_date', { ascending: true, nullsFirst: false })

  // Fetch company names for tasks with account_id
  const accountIds = Array.from(new Set((rawTasks ?? []).filter(t => t.account_id).map(t => t.account_id)))
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

  const tasks: Task[] = (rawTasks ?? []).map(t => ({
    ...t,
    company_name: t.account_id ? accountMap[t.account_id] ?? null : null,
  }))

  // Group tasks into sections
  const isOverdue = (t: Task) => t.due_date !== null && t.due_date < today
  const isUrgent = (t: Task) => t.priority === 'Urgent' || isOverdue(t)

  const urgente = tasks.filter(t => isUrgent(t))
  const urgenteIds = new Set(urgente.map(t => t.id))
  const inCorso = tasks.filter(t => t.status === 'In Progress' && !urgenteIds.has(t.id))
  const inCorsoIds = new Set(inCorso.map(t => t.id))
  const normale = tasks.filter(t => !urgenteIds.has(t.id) && !inCorsoIds.has(t.id))

  const grouped: GroupedTasks = { urgente, inCorso, normale }

  const stats: TaskStats = {
    total: tasks.length,
    urgent: urgente.length,
    waiting: tasks.filter(t => t.status === 'Waiting').length,
    overdue: tasks.filter(t => isOverdue(t)).length,
    inProgress: tasks.filter(t => t.status === 'In Progress').length,
  }

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Task Board</h1>
        <p className="text-muted-foreground text-sm mt-1">Vista quotidiana dei task operativi</p>
      </div>
      <TaskBoard tasks={grouped} stats={stats} today={today} />
    </div>
  )
}
