/**
 * Supabase Public Client (Anon Key)
 * For client-side public pages: offers, contracts, forms
 * Uses anon key — no auth required
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export const supabasePublic = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

export const LOGO_URL = `${SUPABASE_URL}/storage/v1/object/public/assets/tony-logos.jpg`
