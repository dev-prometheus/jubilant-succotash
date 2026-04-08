/**
 * ============================================================================
 * SERAPH SERVER - Auth Service
 * ============================================================================
 */

import supabase from '../config/supabase.js'
import { hashPassword, verifyPassword } from '../utils/hash.js'
import { generateToken, generateApiKey, hashToken } from '../utils/jwt.js'

/**
 * Register a new operator
 */
export async function registerOperator({ email, username, password }) {
  // Check if email or username already exists
  const { data: existing } = await supabase
    .from('operators')
    .select('id')
    .or(`email.eq.${email},username.eq.${username}`)
    .limit(1)
  
  if (existing && existing.length > 0) {
    throw new Error('Email or username already exists')
  }
  
  // Hash password
  const passwordHash = await hashPassword(password)
  
  // Create operator
  const { data: operator, error } = await supabase
    .from('operators')
    .insert({
      email,
      username,
      password_hash: passwordHash
    })
    .select('id, email, username, api_key, created_at')
    .single()
  
  if (error) {
    throw new Error(error.message)
  }
  
  // Generate JWT token
  const token = generateToken({
    id: operator.id,
    email: operator.email,
    username: operator.username,
    type: 'operator'
  })
  
  // Log activity
  await logActivity({
    userId: operator.id,
    userType: 'operator',
    action: 'operator.registered',
    entityType: 'operator',
    entityId: operator.id
  })
  
  return {
    operator: {
      id: operator.id,
      email: operator.email,
      username: operator.username,
      apiKey: operator.api_key,
      createdAt: operator.created_at
    },
    token
  }
}

/**
 * Login operator
 */
export async function loginOperator({ email, password }) {
  // Find operator
  const { data: operator, error } = await supabase
    .from('operators')
    .select('id, email, username, password_hash, status, api_key')
    .eq('email', email)
    .single()
  
  if (error || !operator) {
    throw new Error('Invalid credentials')
  }
  
  if (operator.status !== 'active') {
    throw new Error(`Account ${operator.status}`)
  }
  
  // Verify password
  const valid = await verifyPassword(password, operator.password_hash)
  if (!valid) {
    throw new Error('Invalid credentials')
  }
  
  // Update last login
  await supabase
    .from('operators')
    .update({ last_login: new Date().toISOString() })
    .eq('id', operator.id)
  
  // Generate token
  const token = generateToken({
    id: operator.id,
    email: operator.email,
    username: operator.username,
    type: 'operator'
  })
  
  // Log activity
  await logActivity({
    userId: operator.id,
    userType: 'operator',
    action: 'operator.login',
    entityType: 'operator',
    entityId: operator.id
  })
  
  return {
    operator: {
      id: operator.id,
      email: operator.email,
      username: operator.username,
      apiKey: operator.api_key
    },
    token
  }
}

/**
 * Login admin
 */
export async function loginAdmin({ email, password }) {
  // Find admin
  const { data: admin, error } = await supabase
    .from('admins')
    .select('id, email, username, password_hash, role, is_active')
    .eq('email', email)
    .single()
  
  if (error || !admin) {
    throw new Error('Invalid credentials')
  }
  
  if (!admin.is_active) {
    throw new Error('Account inactive')
  }
  
  // Verify password
  const valid = await verifyPassword(password, admin.password_hash)
  if (!valid) {
    throw new Error('Invalid credentials')
  }
  
  // Update last login
  await supabase
    .from('admins')
    .update({ last_login: new Date().toISOString() })
    .eq('id', admin.id)
  
  // Generate token
  const token = generateToken({
    id: admin.id,
    email: admin.email,
    username: admin.username,
    type: 'admin',
    role: admin.role
  })
  
  // Log activity
  await logActivity({
    userId: admin.id,
    userType: 'admin',
    action: 'admin.login',
    entityType: 'admin',
    entityId: admin.id
  })
  
  return {
    admin: {
      id: admin.id,
      email: admin.email,
      username: admin.username,
      role: admin.role
    },
    token
  }
}

/**
 * Create admin (super admin only)
 */
export async function createAdmin({ email, username, password, role = 'admin' }) {
  // Check if email or username already exists
  const { data: existing } = await supabase
    .from('admins')
    .select('id')
    .or(`email.eq.${email},username.eq.${username}`)
    .limit(1)
  
  if (existing && existing.length > 0) {
    throw new Error('Email or username already exists')
  }
  
  const passwordHash = await hashPassword(password)
  
  const { data: admin, error } = await supabase
    .from('admins')
    .insert({
      email,
      username,
      password_hash: passwordHash,
      role
    })
    .select('id, email, username, role, created_at')
    .single()
  
  if (error) {
    throw new Error(error.message)
  }
  
  return admin
}

/**
 * Get current user profile
 */
export async function getProfile(userId, userType) {
  const table = userType === 'admin' ? 'admins' : 'operators'
  const select = userType === 'admin'
    ? 'id, email, username, role, is_active, created_at, last_login'
    : 'id, email, username, status, api_key, total_campaigns, total_drains, total_value_usd, created_at, last_login'
  
  const { data, error } = await supabase
    .from(table)
    .select(select)
    .eq('id', userId)
    .single()
  
  if (error) {
    throw new Error('Profile not found')
  }
  
  return data
}

/**
 * Update password
 */
export async function updatePassword(userId, userType, currentPassword, newPassword) {
  const table = userType === 'admin' ? 'admins' : 'operators'
  
  // Get current hash
  const { data: user, error } = await supabase
    .from(table)
    .select('password_hash')
    .eq('id', userId)
    .single()
  
  if (error || !user) {
    throw new Error('User not found')
  }
  
  // Verify current password
  const valid = await verifyPassword(currentPassword, user.password_hash)
  if (!valid) {
    throw new Error('Current password is incorrect')
  }
  
  // Hash new password
  const newHash = await hashPassword(newPassword)
  
  // Update
  const { error: updateError } = await supabase
    .from(table)
    .update({ password_hash: newHash })
    .eq('id', userId)
  
  if (updateError) {
    throw new Error('Failed to update password')
  }
  
  return true
}

/**
 * Log activity
 */
async function logActivity({ userId, userType, action, entityType, entityId, details = {}, ipAddress }) {
  try {
    await supabase
      .from('activity_logs')
      .insert({
        user_id: userId,
        user_type: userType,
        action,
        entity_type: entityType,
        entity_id: entityId,
        details,
        ip_address: ipAddress
      })
  } catch (err) {
    console.error('Failed to log activity:', err.message)
  }
}

export default {
  registerOperator,
  loginOperator,
  loginAdmin,
  createAdmin,
  getProfile,
  updatePassword
}
