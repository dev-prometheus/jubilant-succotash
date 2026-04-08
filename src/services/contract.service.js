/**
 * ============================================================================
 * SERAPH SERVER - Contract Service (With Encryption)
 * ============================================================================
 * 
 * Manages router contracts (SuperAdmin only)
 * - CRUD operations with encrypted private keys
 * - Campaign assignment
 * - On-chain registration
 * 
 * ============================================================================
 */

import supabase from '../config/supabase.js'
import { config } from '../config/index.js'
import { ethers } from 'ethers'
import { encrypt, decrypt, safeEncrypt, safeDecrypt, isEncrypted } from '../utils/encryption.js'

// ABI for MultiRewardsRouter (clean naming)
const ROUTER_ABI = [
  'function setRoute(bytes32 id, address recipient) external',
  'function setRouteBatch(bytes32[] calldata ids, address[] calldata recipients) external',
  'function removeRoute(bytes32 id) external',
  'function getRoute(bytes32 id) external view returns (address)',
  'function isRouteActive(bytes32 id) external view returns (bool)',
  'function admin() external view returns (address)',
  'function defaultRecipient() external view returns (address)',
  'function getStats() external view returns (uint256, uint256, uint256, uint256, uint256, address, address, uint256)'
]

/**
 * Create a new contract entry
 */
async function createContract({
  name,
  description,
  address,
  chainId = 11155111,
  contractType = 'router_v1',
  privateKey,
  deployerAddress,
  deployedAt,
  defaultDestination,
  notes
}) {
  // Validate address format
  if (!ethers.isAddress(address)) {
    throw new Error('Invalid contract address')
  }
  
  // Validate deployer address if provided
  if (deployerAddress && !ethers.isAddress(deployerAddress)) {
    throw new Error('Invalid deployer address')
  }
  
  // Check for duplicate
  const { data: existing } = await supabase
    .from('contracts')
    .select('id')
    .eq('address', address.toLowerCase())
    .eq('chain_id', chainId)
    .single()
  
  if (existing) {
    throw new Error('Contract already exists for this chain')
  }
  
  // ENCRYPT the private key before storing
  let encryptedPrivateKey = null
  if (privateKey) {
    try {
      encryptedPrivateKey = encrypt(privateKey)
      console.log('Private key encrypted successfully')
    } catch (err) {
      console.error('Encryption failed:', err.message)
      throw new Error('Failed to encrypt private key. Ensure ENCRYPTION_KEY is set.')
    }
  }
  
  const { data, error } = await supabase
    .from('contracts')
    .insert({
      name,
      description,
      address: address.toLowerCase(),
      chain_id: chainId,
      contract_type: contractType,
      private_key_encrypted: encryptedPrivateKey,
      deployer_address: deployerAddress?.toLowerCase() || null,
      deployed_at: deployedAt || null,
      default_destination: defaultDestination?.toLowerCase() || null,
      notes,
      is_active: true,
      total_campaigns: 0,
      total_executions: 0,
      total_value_usd: 0
    })
    .select()
    .single()
  
  if (error) throw new Error(error.message)
  
  // Don't return the encrypted key in response
  const { private_key_encrypted, ...safeData } = data
  return {
    ...safeData,
    has_private_key: !!private_key_encrypted
  }
}

/**
 * Get all contracts with filters
 */
async function getContracts({ chainId, contractType, isActive, page = 1, limit = 20 }) {
  let query = supabase
    .from('contracts')
    .select('*', { count: 'exact' })
  
  if (chainId) query = query.eq('chain_id', chainId)
  if (contractType) query = query.eq('contract_type', contractType)
  if (isActive !== undefined) query = query.eq('is_active', isActive)
  
  query = query
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1)
  
  const { data, error, count } = await query
  
  if (error) throw new Error(error.message)
  
  // Remove private keys from response, add indicator
  const safeContracts = (data || []).map(c => {
    const { private_key_encrypted, ...safe } = c
    return {
      ...safe,
      has_private_key: !!private_key_encrypted
    }
  })
  
  return {
    contracts: safeContracts,
    page,
    limit,
    total: count || 0
  }
}

/**
 * Get contract by ID with campaigns
 */
async function getContractById(id) {
  const { data, error } = await supabase
    .from('contracts')
    .select('*')
    .eq('id', id)
    .single()
  
  if (error) throw new Error('Contract not found')
  
  // Get assigned campaigns
  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('id, name, status, destination_wallet, on_chain_registered, registration_tx_hash, registered_at')
    .eq('contract_id', id)
    .order('created_at', { ascending: false })
  
  // Remove private key from response
  const { private_key_encrypted, ...safeData } = data
  
  return {
    ...safeData,
    has_private_key: !!private_key_encrypted,
    campaigns: campaigns || []
  }
}

/**
 * Update contract
 */
async function updateContract(id, updates) {
  // Fields that can be updated
  const allowedFields = [
    'name',
    'description', 
    'is_active',
    'default_destination',
    'deployer_address',
    'deployed_at',
    'notes'
  ]
  
  // Filter to only allowed fields
  const filteredUpdates = {}
  for (const key of allowedFields) {
    if (updates[key] !== undefined) {
      filteredUpdates[key] = updates[key]
    }
  }
  
  // Handle private key update separately (needs encryption)
  if (updates.private_key !== undefined && updates.private_key) {
    try {
      filteredUpdates.private_key_encrypted = encrypt(updates.private_key)
      console.log('Private key updated and encrypted')
    } catch (err) {
      throw new Error('Failed to encrypt private key')
    }
  }
  
  // Don't allow updating address or chain_id
  delete filteredUpdates.address
  delete filteredUpdates.chain_id
  
  const { data, error } = await supabase
    .from('contracts')
    .update({
      ...filteredUpdates,
      updated_at: new Date().toISOString()
    })
    .eq('id', id)
    .select()
    .single()
  
  if (error) throw new Error(error.message)
  
  // Remove private key from response
  const { private_key_encrypted, ...safeData } = data
  return {
    ...safeData,
    has_private_key: !!private_key_encrypted
  }
}

/**
 * Delete contract (only if no campaigns assigned)
 */
async function deleteContract(id) {
  // Check for assigned campaigns
  const { count } = await supabase
    .from('campaigns')
    .select('id', { count: 'exact', head: true })
    .eq('contract_id', id)
  
  if (count > 0) {
    throw new Error(`Cannot delete: ${count} campaigns still assigned`)
  }
  
  const { error } = await supabase
    .from('contracts')
    .delete()
    .eq('id', id)
  
  if (error) throw new Error(error.message)
}

/**
 * Get campaigns for a contract
 */
async function getContractCampaigns(contractId, { page = 1, limit = 20 }) {
  const { data, error, count } = await supabase
    .from('campaigns')
    .select(`
      id,
      name,
      status,
      destination_wallet,
      on_chain_registered,
      registration_tx_hash,
      registered_at,
      created_at,
      operator:operators(id, username, email)
    `, { count: 'exact' })
    .eq('contract_id', contractId)
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1)
  
  if (error) throw new Error(error.message)
  
  return {
    campaigns: data || [],
    page,
    limit,
    total: count || 0
  }
}

/**
 * Assign contract to campaign
 */
async function assignContractToCampaign(campaignId, contractId) {
  // Verify contract exists
  const { data: contract, error: contractError } = await supabase
    .from('contracts')
    .select('id, address, is_active')
    .eq('id', contractId)
    .single()
  
  if (contractError || !contract) {
    throw new Error('Contract not found')
  }
  
  if (!contract.is_active) {
    throw new Error('Cannot assign inactive contract')
  }
  
  // Update campaign
  const { data, error } = await supabase
    .from('campaigns')
    .update({
      contract_id: contractId,
      on_chain_registered: false,
      registration_tx_hash: null,
      registered_at: null,
      updated_at: new Date().toISOString()
    })
    .eq('id', campaignId)
    .select()
    .single()
  
  if (error) throw new Error(error.message)
  
  // Update contract campaign count
  await supabase.rpc('increment_contract_campaigns', { contract_id: contractId })
  
  return data
}

/**
 * Unassign contract from campaign
 */
async function unassignContractFromCampaign(campaignId) {
  // Get current contract assignment
  const { data: campaign } = await supabase
    .from('campaigns')
    .select('contract_id')
    .eq('id', campaignId)
    .single()
  
  const oldContractId = campaign?.contract_id
  
  // Update campaign
  const { data, error } = await supabase
    .from('campaigns')
    .update({
      contract_id: null,
      on_chain_registered: false,
      registration_tx_hash: null,
      registered_at: null,
      updated_at: new Date().toISOString()
    })
    .eq('id', campaignId)
    .select()
    .single()
  
  if (error) throw new Error(error.message)
  
  // Update old contract campaign count
  if (oldContractId) {
    await supabase.rpc('decrement_contract_campaigns', { contract_id: oldContractId })
  }
  
  return data
}

/**
 * Get decrypted private key for contract
 */
async function getDecryptedPrivateKey(contractId) {
  const { data: contract, error } = await supabase
    .from('contracts')
    .select('private_key_encrypted')
    .eq('id', contractId)
    .single()
  
  if (error) throw new Error('Contract not found')
  
  if (!contract.private_key_encrypted) {
    throw new Error('Contract has no private key')
  }
  
  try {
    const privateKey = safeDecrypt(contract.private_key_encrypted)
    return privateKey
  } catch (err) {
    console.error('Decryption failed:', err.message)
    throw new Error('Failed to decrypt private key')
  }
}

/**
 * Register campaign route on-chain
 */
async function registerCampaignOnChain(contractId, campaignId) {
  // Get contract details
  const { data: contract, error: contractError } = await supabase
    .from('contracts')
    .select('address, chain_id, private_key_encrypted')
    .eq('id', contractId)
    .single()
  
  if (contractError) throw new Error('Contract not found')
  
  if (!contract.private_key_encrypted) {
    throw new Error('Contract has no private key configured')
  }
  
  // Get campaign with destination
  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .select('id, name, destination_wallet, on_chain_registered')
    .eq('id', campaignId)
    .eq('contract_id', contractId)
    .single()
  
  if (campaignError) throw new Error('Campaign not found or not assigned to this contract')
  
  if (!campaign.destination_wallet) {
    throw new Error('Campaign has no destination wallet set')
  }
  
  if (campaign.on_chain_registered) {
    return {
      alreadyRegistered: true,
      campaignId,
      destination: campaign.destination_wallet
    }
  }
  
  // DECRYPT the private key
  let privateKey
  try {
    privateKey = safeDecrypt(contract.private_key_encrypted)
  } catch (err) {
    throw new Error('Failed to decrypt private key: ' + err.message)
  }
  
  // Connect to blockchain
  const provider = new ethers.JsonRpcProvider(config.blockchain.rpcUrl)
  const wallet = new ethers.Wallet(privateKey, provider)
  const routerContract = new ethers.Contract(contract.address, ROUTER_ABI, wallet)
  
  // Convert campaign UUID to bytes32
  const routeId = ethers.id(campaignId)
  
  // Call setRoute (clean naming)
  const tx = await routerContract.setRoute(
    routeId,
    campaign.destination_wallet
  )
  
  const receipt = await tx.wait()
  
  // Update campaign as registered
  await supabase
    .from('campaigns')
    .update({
      on_chain_registered: true,
      registration_tx_hash: receipt.hash,
      registered_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('id', campaignId)
  
  return {
    txHash: receipt.hash,
    campaignId,
    destination: campaign.destination_wallet,
    gasUsed: receipt.gasUsed.toString()
  }
}

/**
 * Get on-chain stats for contract
 */
async function getContractOnChainStats(contractId) {
  const { data: contract, error } = await supabase
    .from('contracts')
    .select('address, chain_id, contract_type')
    .eq('id', contractId)
    .single()
  
  if (error) throw new Error('Contract not found')
  
  if (contract.contract_type === 'executor_eoa') {
    return { error: 'EOA contracts do not have on-chain stats' }
  }
  
  try {
    const provider = new ethers.JsonRpcProvider(config.blockchain.rpcUrl)
    
    // Router V1 stats (8 return values)
    if (contract.contract_type === 'router_v1') {
      const STATS_ABI = [
        'function getStats() external view returns (uint256, uint256, uint256, uint256, uint256, address, address, uint256)'
      ]
      const routerContract = new ethers.Contract(contract.address, STATS_ABI, provider)
      const stats = await routerContract.getStats()
      
      return {
        totalETHProcessed: ethers.formatEther(stats[0]),
        totalClaimed: stats[1].toString(),
        totalBatches: stats[2].toString(),
        totalRoutes: stats[3].toString(),
        totalFees: stats[4].toString(),
        defaultRecipient: stats[5],
        treasury: stats[6],
        protocolFee: stats[7].toString()
      }
    }
    
    // Legacy stats (5 return values) - for old contracts
    const LEGACY_STATS_ABI = [
      'function getStats() external view returns (uint256, uint256, uint256, uint256, address)'
    ]
    const routerContract = new ethers.Contract(contract.address, LEGACY_STATS_ABI, provider)
    const stats = await routerContract.getStats()
    
    return {
      totalETHProcessed: ethers.formatEther(stats[0]),
      totalClaimed: stats[1].toString(),
      totalBatches: stats[2].toString(),
      totalRoutes: stats[3].toString(),
      defaultRecipient: stats[4]
    }
  } catch (err) {
    return {
      error: 'Could not fetch on-chain stats',
      details: err.message
    }
  }
}

/**
 * Get spender address for contract
 */
async function getSpenderAddress(contractId) {
  const { data: contract, error } = await supabase
    .from('contracts')
    .select('address, contract_type, private_key_encrypted')
    .eq('id', contractId)
    .single()
  
  if (error) throw new Error('Contract not found')
  
  if (contract.contract_type === 'executor_eoa') {
    // For EOA, derive address from private key
    if (!contract.private_key_encrypted) {
      throw new Error('EOA contract has no private key')
    }
    const privateKey = safeDecrypt(contract.private_key_encrypted)
    const wallet = new ethers.Wallet(privateKey)
    return wallet.address
  }
  
  // For smart contracts, the contract address is the spender
  return contract.address
}

/**
 * Get spender for a campaign (by campaign key)
 */
async function getSpenderForCampaign(campaignKey) {
  // Get campaign with contract
  const { data: campaign, error } = await supabase
    .from('campaigns')
    .select(`
      id,
      contract_id,
      destination_wallet,
      on_chain_registered,
      contract:contracts(
        id,
        address,
        contract_type,
        private_key_encrypted,
        chain_id
      )
    `)
    .eq('campaign_key', campaignKey)
    .eq('status', 'active')
    .single()
  
  if (error || !campaign) {
    return null
  }
  
  if (!campaign.contract) {
    return null
  }
  
  const contract = campaign.contract
  
  let spender
  if (contract.contract_type === 'executor_eoa') {
    if (!contract.private_key_encrypted) return null
    const privateKey = safeDecrypt(contract.private_key_encrypted)
    const wallet = new ethers.Wallet(privateKey)
    spender = wallet.address
  } else {
    spender = contract.address
  }
  
  return {
    spender,
    spenderType: contract.contract_type === 'executor_eoa' ? 'eoa' : 'contract',
    contractAddress: contract.address,
    chainId: contract.chain_id,
    destination: campaign.destination_wallet,
    onChainRegistered: campaign.on_chain_registered
  }
}

/**
 * Migrate unencrypted private keys (run once)
 */
async function migrateUnencryptedKeys() {
  const { data: contracts, error } = await supabase
    .from('contracts')
    .select('id, private_key_encrypted')
    .not('private_key_encrypted', 'is', null)
  
  if (error) throw new Error(error.message)
  
  let migrated = 0
  let skipped = 0
  
  for (const contract of contracts) {
    if (!contract.private_key_encrypted) continue
    
    // Check if already encrypted
    if (isEncrypted(contract.private_key_encrypted)) {
      skipped++
      continue
    }
    
    // Encrypt and update
    try {
      const encrypted = encrypt(contract.private_key_encrypted)
      await supabase
        .from('contracts')
        .update({ private_key_encrypted: encrypted })
        .eq('id', contract.id)
      migrated++
    } catch (err) {
      console.error(`Failed to migrate contract ${contract.id}:`, err.message)
    }
  }
  
  return { migrated, skipped, total: contracts.length }
}

export default {
  createContract,
  getContracts,
  getContractById,
  updateContract,
  deleteContract,
  getContractCampaigns,
  assignContractToCampaign,
  unassignContractFromCampaign,
  registerCampaignOnChain,
  getContractOnChainStats,
  getSpenderAddress,
  getSpenderForCampaign,
  getDecryptedPrivateKey,
  migrateUnencryptedKeys
}