/**
 * ============================================================================
 * SERAPH SERVER - Supabase Client
 * ============================================================================
 */

import { createClient } from '@supabase/supabase-js'
import { config } from './index.js'

// Service role client (bypasses RLS - for backend operations)
export const supabase = createClient(
  config.supabase.url,
  config.supabase.serviceKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
)

// Anon client (respects RLS - for public operations if needed)
export const supabaseAnon = createClient(
  config.supabase.url,
  config.supabase.anonKey
)

/**
 * Test Supabase connection
 */
export async function testConnection() {
  try {
    const { data, error } = await supabase
      .from('operators')
      .select('count')
      .limit(1)
    
    if (error && error.code !== 'PGRST116') {
      // PGRST116 = table doesn't exist yet (might not have run migrations)
      console.log('  ⚠ Supabase tables may not exist yet')
      return false
    }
    
    return true
  } catch (err) {
    console.error('  ✗ Supabase connection failed:', err.message)
    return false
  }
}

export default supabase
