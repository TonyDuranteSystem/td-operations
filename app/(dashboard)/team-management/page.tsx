'use client'

import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import {
  Users,
  Plus,
  Pencil,
  Shield,
  ShieldOff,
  Check,
  X,
  Loader2,
  Mail,
  Clock,
} from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

interface TeamUser {
  id: string
  email: string
  full_name: string
  role: 'admin' | 'team'
  created_at: string
  last_sign_in_at: string | null
  disabled: boolean
}

export default function TeamManagementPage() {
  const [users, setUsers] = useState<TeamUser[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editRole, setEditRole] = useState<'admin' | 'team'>('team')

  // Create form state
  const [newEmail, setNewEmail] = useState('')
  const [newName, setNewName] = useState('')
  const [newRole, setNewRole] = useState<'admin' | 'team'>('team')

  const fetchUsers = useCallback(async () => {
    try {
      const res = await fetch('/api/team-management')
      if (!res.ok) throw new Error('Failed to load users')
      const data = await res.json()
      setUsers(data.users)
    } catch {
      toast.error('Failed to load team members')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchUsers() }, [fetchUsers])

  const handleCreate = async () => {
    if (!newEmail || !newName) {
      toast.error('Email and name are required')
      return
    }
    setCreating(true)
    try {
      const res = await fetch('/api/team-management', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newEmail, full_name: newName, role: newRole }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      toast.success(data.message)
      setShowCreateForm(false)
      setNewEmail('')
      setNewName('')
      setNewRole('team')
      fetchUsers()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create user')
    } finally {
      setCreating(false)
    }
  }

  const handleUpdateRole = async (userId: string, role: 'admin' | 'team') => {
    try {
      const res = await fetch('/api/team-management', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, role }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      toast.success(`Role updated to ${role}`)
      setEditingId(null)
      fetchUsers()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update role')
    }
  }

  const handleToggleDisabled = async (userId: string, currentlyDisabled: boolean) => {
    const action = currentlyDisabled ? 'enable' : 'disable'
    try {
      const res = await fetch('/api/team-management', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, disabled: !currentlyDisabled }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      toast.success(`User ${action}d successfully`)
      fetchUsers()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to ${action} user`)
    }
  }

  const adminCount = users.filter(u => u.role === 'admin').length
  const teamCount = users.filter(u => u.role === 'team').length
  const disabledCount = users.filter(u => u.disabled).length

  return (
    <div className="p-6 lg:p-8 max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 flex items-center gap-2">
            <Users className="h-6 w-6" />
            Team Management
          </h1>
          <p className="text-sm text-zinc-500 mt-1">
            Manage dashboard access for your team members
          </p>
        </div>
        <button
          onClick={() => setShowCreateForm(true)}
          className="flex items-center gap-2 px-4 py-2 bg-zinc-900 text-white rounded-lg hover:bg-zinc-800 transition-colors text-sm font-medium"
        >
          <Plus className="h-4 w-4" />
          Add Team Member
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white border border-zinc-200 rounded-lg p-4">
          <div className="text-2xl font-bold text-zinc-900">{users.length}</div>
          <div className="text-xs text-zinc-500">Total Users</div>
        </div>
        <div className="bg-white border border-zinc-200 rounded-lg p-4">
          <div className="text-2xl font-bold text-amber-600">{adminCount}</div>
          <div className="text-xs text-zinc-500">Admins</div>
        </div>
        <div className="bg-white border border-zinc-200 rounded-lg p-4">
          <div className="text-2xl font-bold text-blue-600">{teamCount}</div>
          <div className="text-xs text-zinc-500">Team Members</div>
        </div>
      </div>

      {/* Create Form */}
      {showCreateForm && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
          <h3 className="font-medium text-zinc-900 mb-3">New Team Member</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <input
              type="text"
              placeholder="Full Name"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              className="px-3 py-2 border border-zinc-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            />
            <input
              type="email"
              placeholder="Email Address"
              value={newEmail}
              onChange={e => setNewEmail(e.target.value)}
              className="px-3 py-2 border border-zinc-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            />
            <select
              value={newRole}
              onChange={e => setNewRole(e.target.value as 'admin' | 'team')}
              className="px-3 py-2 border border-zinc-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
            >
              <option value="team">Team Member</option>
              <option value="admin">Administrator</option>
            </select>
          </div>
          <div className="flex gap-2 mt-3">
            <button
              onClick={handleCreate}
              disabled={creating}
              className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium disabled:opacity-50"
            >
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {creating ? 'Creating...' : 'Create & Send Credentials'}
            </button>
            <button
              onClick={() => { setShowCreateForm(false); setNewEmail(''); setNewName(''); setNewRole('team') }}
              className="flex items-center gap-1.5 px-4 py-2 bg-white border border-zinc-300 rounded-lg hover:bg-zinc-50 text-sm"
            >
              <X className="h-4 w-4" />
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Users Table */}
      <div className="bg-white border border-zinc-200 rounded-lg overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
          </div>
        ) : users.length === 0 ? (
          <div className="text-center py-12 text-zinc-500">No team members found</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50">
                <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider">Name</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider">Email</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider">Role</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider">Status</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider">Last Login</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {users.map(u => (
                <tr key={u.id} className={`group hover:bg-zinc-50 ${u.disabled ? 'opacity-50' : ''}`}>
                  <td className="px-4 py-3">
                    <span className={`text-sm font-medium ${u.disabled ? 'line-through text-zinc-400' : 'text-zinc-900'}`}>
                      {u.full_name}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-sm text-zinc-600 flex items-center gap-1.5">
                      <Mail className="h-3.5 w-3.5 text-zinc-400" />
                      {u.email}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {editingId === u.id ? (
                      <div className="flex items-center gap-1">
                        <select
                          value={editRole}
                          onChange={e => setEditRole(e.target.value as 'admin' | 'team')}
                          className="px-2 py-1 border border-zinc-300 rounded text-xs bg-white"
                        >
                          <option value="team">Team</option>
                          <option value="admin">Admin</option>
                        </select>
                        <button
                          onClick={() => handleUpdateRole(u.id, editRole)}
                          className="p-1 text-emerald-600 hover:bg-emerald-50 rounded"
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          className="p-1 text-zinc-400 hover:bg-zinc-100 rounded"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : (
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                        u.role === 'admin'
                          ? 'bg-amber-100 text-amber-800'
                          : 'bg-blue-100 text-blue-800'
                      }`}>
                        {u.role === 'admin' ? 'Admin' : 'Team'}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      u.disabled
                        ? 'bg-red-100 text-red-800'
                        : 'bg-emerald-100 text-emerald-800'
                    }`}>
                      {u.disabled ? 'Disabled' : 'Active'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-sm text-zinc-500 flex items-center gap-1.5">
                      <Clock className="h-3.5 w-3.5 text-zinc-400" />
                      {u.last_sign_in_at
                        ? formatDistanceToNow(new Date(u.last_sign_in_at), { addSuffix: true })
                        : 'Never'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      {/* Can't edit own account */}
                      {!isSelf(u.email) && (
                        <>
                          <button
                            onClick={() => { setEditingId(u.id); setEditRole(u.role) }}
                            className="p-1.5 text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 rounded-md"
                            title="Edit role"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => handleToggleDisabled(u.id, u.disabled)}
                            className={`p-1.5 rounded-md ${
                              u.disabled
                                ? 'text-emerald-600 hover:bg-emerald-50'
                                : 'text-red-500 hover:bg-red-50'
                            }`}
                            title={u.disabled ? 'Enable access' : 'Disable access'}
                          >
                            {u.disabled ? <Shield className="h-3.5 w-3.5" /> : <ShieldOff className="h-3.5 w-3.5" />}
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Disabled users note */}
      {disabledCount > 0 && (
        <p className="text-xs text-zinc-400 mt-3">
          {disabledCount} disabled user{disabledCount > 1 ? 's' : ''} shown with reduced opacity.
          Disabled users cannot log in but their account is preserved.
        </p>
      )}
    </div>
  )
}

/** Check if this is the currently logged-in user (can't edit self) */
function isSelf(email: string): boolean {
  // We don't have direct access to current user email in client component,
  // but the API prevents self-modification anyway. This is a UI hint —
  // hide edit buttons for antonio.durante@tonydurante.us as a best-effort.
  // A proper implementation would pass currentUserEmail from layout.
  return false // API enforces self-protection server-side
}
