'use client'

import { useEffect, useMemo, useState } from 'react'
import { ACCESS_GROUPS, accessWarnings, describeAccess, permissionsOfRoles, previewMenu, type Bundles } from '@/lib/marketing/access'
import { PERMISSION_LABELS, roleLabel } from '@/lib/marketing/permission-labels'
import { useT } from '@/components/marketing/lang-provider'

export interface PopupRole { key: string; permissions: string[] }

interface Props {
  /** 'invite' asks for an email; 'edit' changes a person who is already on the team */
  mode: 'invite' | 'edit'
  /** who is being changed (edit) */
  personName?: string
  /** the roles Antonio set up: presets that fill in the ticks */
  roles: PopupRole[]
  /** what the person opening this popup may give: ticks outside it are shown but cannot be changed */
  grantable: string[]
  /** the person's current ticks (edit); empty for an invite */
  initial: string[]
  busy: boolean
  error: string | null
  onCancel: () => void
  onSubmit: (v: { email: string; permissions: string[] }) => void
}

const btn = 'rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-50'

/**
 * The access popup (TD Marketing, dev job 9aec66fa): roles are only presets that fill in a plain checklist; what is saved is the exact list of ticks. A live list on the right shows the
 * menu the person will get (the real menu's own rules), where they land, a plain "will / will not" line and warnings with a one-click fix. Used for a new invitation and for the gear on each person.
 */
export function AccessPopup({ mode, personName, roles, grantable, initial, busy, error, onCancel, onSubmit }: Props) {
  const t = useT()
  const lab = (p: string): string => t((PERMISSION_LABELS as Record<string, string>)[p] ?? p)
  const bundles: Bundles = useMemo(() => Object.fromEntries(roles.map(r => [r.key, r.permissions])), [roles])
  const may = useMemo(() => new Set(grantable), [grantable])
  const initialRoles = useMemo(() => (mode === 'edit' ? describeAccess(initial, bundles).roles : []), [mode, initial, bundles])
  const [email, setEmail] = useState('')
  const [picked, setPicked] = useState<string[]>(initialRoles)
  const [ticks, setTicks] = useState<Set<string>>(new Set(initial))
  const [keep, setKeep] = useState<string[]>([])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  const list = useMemo(() => Array.from(ticks), [ticks])
  const base = useMemo(() => permissionsOfRoles(picked, bundles).filter(p => may.has(p)), [picked, bundles, may])
  const d = useMemo(() => describeAccess(list, bundles), [list, bundles])
  const diffAgainstPicked = useMemo(() => {
    const have = new Set(list), want = new Set(base)
    return { added: list.filter(p => !want.has(p)), missing: base.filter(p => !have.has(p)) }
  }, [list, base])
  const changes = diffAgainstPicked.added.length + diffAgainstPicked.missing.length
  const preview = useMemo(() => previewMenu(list), [list])
  const warnings = useMemo(() => accessWarnings(list).filter(w => !keep.includes(w.text)), [list, keep])
  const name = mode === 'invite' ? (email.split('@')[0] || t('They')) : (personName ?? t('They'))

  function toggleRole(key: string) {
    const next = picked.includes(key) ? picked.filter(k => k !== key) : [...picked, key]
    setPicked(next)
    // presets fill in the ticks (only what you may give); anything you ticked by hand that no role covers is kept
    const oldBase = permissionsOfRoles(picked, bundles)
    const kept = list.filter(p => !oldBase.includes(p))
    // what you un-ticked by hand stays un-ticked when you add or remove a role
    const removedByHand = oldBase.filter(p => !ticks.has(p))
    setTicks(new Set([...permissionsOfRoles(next, bundles).filter(p => may.has(p) && !removedByHand.includes(p)), ...kept]))
  }
  function setKeys(keys: readonly string[], on: boolean) {
    const t = new Set(ticks)
    for (const k of keys) { if (!may.has(k)) continue; if (on) t.add(k); else t.delete(k) }
    setTicks(t)
  }
  const can = Array.from(ticks).filter(p => ['leads.pick', 'leads.worklist', 'team.activity', 'reports.read', 'payment_links.create', 'money.read', 'team.manage'].includes(p)).map(p => lab(p).toLowerCase())
  const cannot = ['leads.call', 'money.read', 'payment_links.create', 'team.notes'].filter(p => !ticks.has(p)).map(p => lab(p).toLowerCase())
  const rolesText = picked.length ? picked.map(k => t(roleLabel(k))).join(' + ') : t('custom access')
  const canSend = !busy && ticks.size > 0 && (mode === 'edit' || email.trim().length > 3)
  const mgrMayGive = may.has('team.manage')

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={mode === 'invite' ? t('Invite someone') : t('Change access for {name}', { name })}>
      <div className="my-6 w-full max-w-4xl rounded-2xl bg-white p-6 shadow-xl" data-testid="access-popup">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold">{mode === 'invite' ? t('Invite someone') : t('Change access for {name}', { name })}</h2>
          <button className="text-sm text-slate-500 underline" onClick={onCancel} disabled={busy}>{t('Cancel')}</button>
        </div>
        {error && <p role="alert" className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
        {mode === 'invite' && (
          <label className="mt-4 block text-sm">
            <span className="text-slate-500">{t('Their email')}</span>
            <input type="email" className="mt-1 w-full rounded-lg border px-3 py-2" value={email} onChange={e => setEmail(e.target.value)} placeholder={t('name@example.com')} autoComplete="off" aria-label={t('Their email')} />
          </label>
        )}

        <p className="mt-4 text-sm text-slate-500">{t('Start from one or more roles')}</p>
        <div className="mt-1 flex flex-wrap gap-2" role="group" aria-label={t('Roles')}>
          {roles.map(r => (
            <button key={r.key} type="button" aria-pressed={picked.includes(r.key)} onClick={() => toggleRole(r.key)} data-role={r.key}
              className={`rounded-lg border px-3 py-1.5 text-sm ${picked.includes(r.key) ? 'border-sky-400 bg-sky-50 text-sky-900' : 'bg-white text-slate-700'}`}>{t(roleLabel(r.key))}</button>
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-500" data-testid="access-state">
          {rolesText}{changes > 0 ? <> · <b className="text-amber-800">{t(changes === 1 ? '{n} change' : '{n} changes', { n: changes })}</b>: {[...diffAgainstPicked.added.map(p => t('added {what}', { what: lab(p).toLowerCase() })), ...diffAgainstPicked.missing.map(p => t('without {what}', { what: lab(p).toLowerCase() }))].join('; ')}</> : t(' · no changes')}
        </p>

        <div className="mt-4 grid gap-6 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <div>
            <p className="text-sm text-slate-500">{t('What they can do')} <span className="text-slate-400">{t('(tick to change)')}</span></p>
            <div className="mt-1">
              {ACCESS_GROUPS.map(g => {
                const on = g.items.filter(i => i.keys.every(k => ticks.has(k))).length
                return (
                  <details key={g.group} className="border-t py-1.5" open={g.group === 'Leads'}>
                    <summary className="flex cursor-pointer justify-between text-sm font-medium"><span>{t(g.group)}</span><span className="font-normal text-slate-500">{on} of {g.items.length}</span></summary>
                    <div className="mt-1 space-y-1 pb-1">
                      {g.items.map(i => {
                        const locked = i.keys.some(k => !may.has(k))
                        return (
                          <label key={i.label} className={`flex items-start gap-2 text-sm ${locked ? 'text-slate-400' : ''}`} title={locked ? t('You do not have this yourself, so you cannot give it.') : undefined}>
                            <input type="checkbox" className="mt-1" disabled={locked} checked={i.keys.every(k => ticks.has(k))} onChange={e => setKeys(i.keys, e.target.checked)} data-perm={i.keys[0]} />
                            <span>{t(i.label)}</span>
                          </label>
                        )
                      })}
                    </div>
                  </details>
                )
              })}
            </div>
            {mgrMayGive && (
              <div className="mt-3 rounded-lg border border-rose-300 p-3">
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={ticks.has('team.manage')} onChange={e => setKeys(['team.manage'], e.target.checked)} data-perm="team.manage" />
                  <span>{t('Can manage the team')}<br /><span className="text-xs text-slate-500">{t("They can invite people and change anyone's access, except yours and the owner's.")}</span></span>
                </label>
              </div>
            )}
          </div>

          <div>
            <p className="text-sm text-slate-500" data-testid="menu-title">{t('What {name} will see in the menu', { name })}</p>
            <ul className="mt-1 rounded-lg border p-1" aria-label={t('Menu preview')}>
              {preview.items.map(i => (
                <li key={i.key} data-menu={i.key} data-on={i.on ? '1' : '0'} className={`rounded px-2.5 py-1.5 text-sm ${i.on ? 'bg-slate-50' : 'text-slate-400 line-through'}`}>{t(i.label)}</li>
              ))}
            </ul>
            <p className="mt-1.5 text-xs text-slate-500" data-testid="opens-on">{t('Opens on: {where}', { where: preview.home ? t(preview.home) : t('nothing yet') })}{ticks.has('leads.pick') && ticks.has('leads.worklist') ? t(' (the Call list is one click away)') : ''}</p>
            {warnings.map(w => (
              <div key={w.text} className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="access-warning">
                {t(w.text)}{' '}
                {w.fixPermission && may.has(w.fixPermission) && <button type="button" className="underline" onClick={() => setKeys([w.fixPermission as string], true)}>{t(w.fixLabel as string)}</button>}
                {' · '}<button type="button" className="underline" onClick={() => setKeep([...keep, w.text])}>{t('Keep as is')}</button>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-5 border-t pt-4">
          <p className="text-sm" data-testid="will"><b className="font-medium">{t('{name} will be able to:', { name })}</b> {can.length ? can.join(', ') : t('see what the checklist allows')}.</p>
          <p className="mt-1 text-sm text-slate-600" data-testid="wont"><b className="font-medium">{t('Will not:')}</b> {cannot.length ? cannot.join(', ') : t('nothing is held back')}{ticks.has('team.manage') ? '' : t('; manage the team')}.</p>
          {d.roles.length === 0 && ticks.size > 0 && <p className="mt-1 text-xs text-slate-500">{t('This does not match any role, so it is shown as custom access on the Team page.')}</p>}
          {mode === 'edit' && <p className="mt-2 text-xs text-slate-500">{t('Takes effect on their next click. Anything they are in the middle of on a page they lose may be lost.')}</p>}
          <div className="mt-3 flex items-center justify-end gap-2">
            <button className={btn} onClick={onCancel} disabled={busy}>{t('Cancel')}</button>
            <button className={`${btn} bg-slate-900 text-white`} disabled={!canSend} onClick={() => onSubmit({ email: email.trim(), permissions: list })} data-testid="access-submit">
              {busy ? t('Working…') : mode === 'invite' ? t('Invite {who} as {role}', { who: email.trim() || t('them'), role: rolesText }) + (changes ? t(changes === 1 ? ' ({n} change)' : ' ({n} changes)', { n: changes }) : '') : t('Save access for {name}', { name })}
            </button>
          </div>
          {mode === 'invite' && <p className="mt-2 text-right text-xs text-slate-500">{t('You get a one-time link to send them yourself. It works for 7 days, once.')}</p>}
        </div>
      </div>
    </div>
  )
}
