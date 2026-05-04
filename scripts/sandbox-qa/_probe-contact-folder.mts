/* eslint-disable no-console -- diagnostic script */
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}

const CONTACT_ID = '92fc7378-efc5-426e-acf8-c0ae00deaded'

async function run() {
  // Pull sandbox SA from Vercel and inject locally so the probe uses the same
  // creds the live deploy uses.
  const { execSync } = await import('child_process')
  execSync('vercel env pull /tmp/sandbox-env-cf.txt --environment=production 2>/dev/null', { encoding: 'utf8' })
  const fs = await import('fs')
  const env = fs.readFileSync('/tmp/sandbox-env-cf.txt', 'utf8')
  for (const line of env.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const k = line.slice(0, eq)
    let v = line.slice(eq + 1)
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    if (k === 'GOOGLE_SA_KEY' || k === 'GOOGLE_IMPERSONATE_EMAIL' || k === 'GOOGLE_SHARED_DRIVE_ID') {
      process.env[k] = v
    }
  }
  fs.unlinkSync('/tmp/sandbox-env-cf.txt')
  console.log('Using sandbox GOOGLE_SA_KEY (len):', process.env.GOOGLE_SA_KEY?.length ?? 0)

  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { ensureContactFolder } = await import('../../lib/drive-folder-utils')

  const { data: contact } = await supabaseAdmin
    .from('contacts')
    .select('id, full_name, first_name, last_name, drive_folder_id, gdrive_folder_url')
    .eq('id', CONTACT_ID)
    .single()
  console.log('contact:', contact)

  const contactName = contact ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.full_name : 'TEST'
  console.log('contactName for folder:', contactName)

  try {
    const r = await ensureContactFolder(CONTACT_ID, contactName)
    console.log('ensureContactFolder OK:')
    console.log('  folderId:', r.folderId)
    console.log('  created:', r.created)
    console.log('  subfolders:', r.subfolders)
  } catch (e) {
    console.log('ensureContactFolder FAILED:', e instanceof Error ? e.message : String(e))
    console.log('stack:', e instanceof Error ? e.stack?.split('\n').slice(0, 6).join('\n') : '')
  }
}

run().catch(e => { console.error(e); process.exit(1) })
