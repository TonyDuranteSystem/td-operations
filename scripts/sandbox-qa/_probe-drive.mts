/* eslint-disable no-console -- diagnostic script */
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}

async function probeDrive() {
  const sandboxKey = process.env.GOOGLE_SA_KEY
  console.log('local GOOGLE_SA_KEY present:', !!sandboxKey, 'len:', sandboxKey?.length ?? 0)

  // Pull the sandbox env to see what Vercel actually has
  const { execSync } = await import('child_process')
  const out = execSync('vercel env pull /tmp/sandbox-env-probe.txt --environment=production 2>&1', { encoding: 'utf8' })
  console.log(out.split('\n').slice(-3).join('\n'))

  const fs = await import('fs')
  const env = fs.readFileSync('/tmp/sandbox-env-probe.txt', 'utf8')
  const sak = env.split('\n').find(l => l.startsWith('GOOGLE_SA_KEY='))
  const ie = env.split('\n').find(l => l.startsWith('GOOGLE_IMPERSONATE_EMAIL='))
  const sdid = env.split('\n').find(l => l.startsWith('GOOGLE_SHARED_DRIVE_ID='))
  console.log('sandbox vercel GOOGLE_SA_KEY line len:', sak?.length, 'value len approx:', (sak?.length ?? 0) - 'GOOGLE_SA_KEY='.length)
  console.log('sandbox vercel GOOGLE_IMPERSONATE_EMAIL:', ie)
  console.log('sandbox vercel GOOGLE_SHARED_DRIVE_ID:', sdid)

  // Set env from the sandbox pull and try a Drive listFolder
  const sandboxSAK = sak?.slice('GOOGLE_SA_KEY='.length).replace(/^"|"$/g, '')
  if (!sandboxSAK || sandboxSAK.length < 100) {
    console.log('SAK appears empty or too short — bailing')
    fs.unlinkSync('/tmp/sandbox-env-probe.txt')
    return
  }

  process.env.GOOGLE_SA_KEY = sandboxSAK
  if (ie) process.env.GOOGLE_IMPERSONATE_EMAIL = ie.slice('GOOGLE_IMPERSONATE_EMAIL='.length).replace(/^"|"$/g, '')
  if (sdid) process.env.GOOGLE_SHARED_DRIVE_ID = sdid.slice('GOOGLE_SHARED_DRIVE_ID='.length).replace(/^"|"$/g, '')

  console.log('\nResolved IMPERSONATE_EMAIL:', process.env.GOOGLE_IMPERSONATE_EMAIL || '(fallback support@tonydurante.us)')
  console.log('Resolved SHARED_DRIVE_ID:', process.env.GOOGLE_SHARED_DRIVE_ID || '(fallback 0AOLZHXSfKUMHUk9PVA)')

  const TD_CLIENTS_ROOT = '1mbz_bUDwC4K259RcC-tDKihjlvdAVXno'

  try {
    const { listFolderAnyDrive } = await import('../../lib/google-drive')
    console.log(`\nProbing listFolderAnyDrive("${TD_CLIENTS_ROOT}") — TD Clients root...`)
    const items = await listFolderAnyDrive(TD_CLIENTS_ROOT) as { files?: { id: string; name: string }[] }
    console.log('  ✓ success — files seen:', items.files?.length ?? 0)
    console.log('  first 5:', items.files?.slice(0, 5).map(f => f.name))
  } catch (e) {
    console.log('  ✗ FAILED:', e instanceof Error ? e.message : String(e))
  }

  fs.unlinkSync('/tmp/sandbox-env-probe.txt')
}

probeDrive().catch(e => { console.error(e); process.exit(1) })
