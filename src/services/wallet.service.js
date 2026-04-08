/**
 * ============================================================================
 * SERAPH SERVER - Wallet Service
 * ============================================================================
 */

import supabase from '../config/supabase.js'
import { ethers } from 'ethers'

/**
 * Add a wallet
 */
export async function addWallet(operatorId, { address, label, chainId = 11155111, isPrimary = false }) {
  // Validate address
  if (!ethers.isAddress(address)) {
    throw new Error('Invalid Ethereum address')
  }
  
  // Normalize address (checksum)
  const normalizedAddress = ethers.getAddress(address)
  
  // Check if already exists for this operator
  const { data: existing } = await supabase
    .from('wallets')
    .select('id')
    .eq('operator_id', operatorId)
    .eq('address', normalizedAddress)
    .eq('chain_id', chainId)
    .single()
  
  if (existing) {
    throw new Error('Wallet already added')
  }
  
  // If setting as primary, unset other primaries
  if (isPrimary) {
    await supabase
      .from('wallets')
      .update({ is_primary: false })
      .eq('operator_id', operatorId)
  }
  
  const { data, error } = await supabase
    .from('wallets')
    .insert({
      operator_id: operatorId,
      address: normalizedAddress,
      label,
      chain_id: chainId,
      is_primary: isPrimary
    })
    .select()
    .single()
  
  if (error) {
    throw new Error(error.message)
  }
  
  return data
}

/**
 * Get operator's wallets (with computed stats)
 */
export async function getWallets(operatorId, { chainId } = {}) {
  let query = supabase
    .from('wallets')
    .select(`
      id,
      operator_id,
      address,
      label,
      chain_id,
      is_primary,
      is_active,
      total_received_usd,
      total_drains,
      created_at,
      updated_at,
      campaigns:campaigns(count)
    `)
    .eq('operator_id', operatorId)
    .eq('is_active', true)
    .order('is_primary', { ascending: false })
    .order('created_at', { ascending: false })
  
  if (chainId) {
    query = query.eq('chain_id', chainId)
  }
  
  const { data, error } = await query
  
  if (error) {
    throw new Error(error.message)
  }
  
  // Map to frontend expected field names
  const wallets = (data || []).map(w => ({
    id: w.id,
    operator_id: w.operator_id,
    address: w.address,
    label: w.label,
    chain_id: w.chain_id,
    is_primary: w.is_primary,
    is_active: w.is_active,
    total_received: w.total_received_usd || 0,      // Map to frontend name
    total_drains: w.total_drains || 0,
    campaigns_count: w.campaigns?.[0]?.count ?? 0,  // Computed from join
    created_at: w.created_at,
    updated_at: w.updated_at
  }))
  
  return wallets
}

/**
 * Get all wallets (admin) - with computed stats
 */
export async function getAllWallets({ page = 1, limit = 20, operatorId, chainId }) {
  let query = supabase
    .from('wallets')
    .select(`
      id,
      operator_id,
      address,
      label,
      chain_id,
      is_primary,
      is_active,
      total_received_usd,
      total_drains,
      created_at,
      updated_at,
      operator:operators(id, username, email),
      campaigns:campaigns(count)
    `, { count: 'exact' })
  
  if (operatorId) {
    query = query.eq('operator_id', operatorId)
  }
  
  if (chainId) {
    query = query.eq('chain_id', chainId)
  }
  
  query = query.order('created_at', { ascending: false })
  
  const from = (page - 1) * limit
  query = query.range(from, from + limit - 1)
  
  const { data, error, count } = await query
  
  if (error) {
    throw new Error(error.message)
  }
  
  // Map to frontend expected field names
  const wallets = (data || []).map(w => ({
    id: w.id,
    operator_id: w.operator_id,
    address: w.address,
    label: w.label,
    chain_id: w.chain_id,
    is_primary: w.is_primary,
    is_active: w.is_active,
    total_received: w.total_received_usd || 0,
    total_drains: w.total_drains || 0,
    campaigns_count: w.campaigns?.[0]?.count ?? 0,
    created_at: w.created_at,
    updated_at: w.updated_at,
    operator: w.operator
  }))
  
  return {
    wallets,
    total: count,
    page,
    limit
  }
}

/**
 * Get wallet by ID (with computed stats)
 */
export async function getWalletById(walletId, operatorId = null) {
  let query = supabase
    .from('wallets')
    .select(`
      id,
      operator_id,
      address,
      label,
      chain_id,
      is_primary,
      is_active,
      total_received_usd,
      total_drains,
      created_at,
      updated_at,
      campaigns:campaigns(count)
    `)
    .eq('id', walletId)
  
  if (operatorId) {
    query = query.eq('operator_id', operatorId)
  }
  
  const { data, error } = await query.single()
  
  if (error) {
    throw new Error('Wallet not found')
  }
  
  return {
    id: data.id,
    operator_id: data.operator_id,
    address: data.address,
    label: data.label,
    chain_id: data.chain_id,
    is_primary: data.is_primary,
    is_active: data.is_active,
    total_received: data.total_received_usd || 0,
    total_drains: data.total_drains || 0,
    campaigns_count: data.campaigns?.[0]?.count ?? 0,
    created_at: data.created_at,
    updated_at: data.updated_at
  }
}

/**
 * Update wallet
 */
export async function updateWallet(walletId, operatorId, { label, isPrimary, isActive }) {
  const updates = { updated_at: new Date().toISOString() }
  
  if (label !== undefined) updates.label = label
  if (isActive !== undefined) updates.is_active = isActive
  
  // If setting as primary, unset others first
  if (isPrimary === true) {
    // Get wallet to find operator
    const { data: wallet } = await supabase
      .from('wallets')
      .select('operator_id')
      .eq('id', walletId)
      .single()
    
    if (wallet) {
      await supabase
        .from('wallets')
        .update({ is_primary: false })
        .eq('operator_id', wallet.operator_id)
    }
    
    updates.is_primary = true
  } else if (isPrimary === false) {
    updates.is_primary = false
  }
  
  let query = supabase
    .from('wallets')
    .update(updates)
    .eq('id', walletId)
  
  if (operatorId) {
    query = query.eq('operator_id', operatorId)
  }
  
  const { data, error } = await query.select().single()
  
  if (error) {
    throw new Error(error.message)
  }
  
  return data
}

/**
 * Delete wallet
 */
export async function deleteWallet(walletId, operatorId = null) {
  // Check if wallet is used by any active campaigns
  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('id, name')
    .eq('wallet_id', walletId)
    .eq('status', 'active')
  
  if (campaigns && campaigns.length > 0) {
    throw new Error(`Wallet is used by ${campaigns.length} active campaign(s)`)
  }
  
  let query = supabase
    .from('wallets')
    .delete()
    .eq('id', walletId)
  
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
 * Get primary wallet for operator
 */
export async function getPrimaryWallet(operatorId, chainId = 11155111) {
  // Try to get primary
  let { data } = await supabase
    .from('wallets')
    .select('*')
    .eq('operator_id', operatorId)
    .eq('chain_id', chainId)
    .eq('is_primary', true)
    .eq('is_active', true)
    .single()
  
  // If no primary, get first active
  if (!data) {
    const { data: firstWallet } = await supabase
      .from('wallets')
      .select('*')
      .eq('operator_id', operatorId)
      .eq('chain_id', chainId)
      .eq('is_active', true)
      .order('created_at', { ascending: true })
      .limit(1)
      .single()
    
    data = firstWallet
  }
  
  return data
}

/**
 * Update wallet stats after a drain
 * Called by drain service when a drain is logged
 */
export async function incrementWalletStats(walletId, valueUsd) {
  const { data: wallet, error: fetchError } = await supabase
    .from('wallets')
    .select('total_received_usd, total_drains')
    .eq('id', walletId)
    .single()
  
  if (fetchError || !wallet) {
    console.error('Failed to fetch wallet for stats update:', fetchError?.message)
    return
  }
  
  const { error } = await supabase
    .from('wallets')
    .update({
      total_received_usd: (parseFloat(wallet.total_received_usd) || 0) + (parseFloat(valueUsd) || 0),
      total_drains: (wallet.total_drains || 0) + 1,
      updated_at: new Date().toISOString()
    })
    .eq('id', walletId)
  
  if (error) {
    console.error('Failed to update wallet stats:', error.message)
  }
}

export default {
  addWallet,
  getWallets,
  getAllWallets,
  getWalletById,
  updateWallet,
  deleteWallet,
  getPrimaryWallet,
  incrementWalletStats
}