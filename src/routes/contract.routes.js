/**
 * ============================================================================
 * SERAPH SERVER - Contract Routes (SuperAdmin only) - Complete
 * ============================================================================
 * 
 * Manages router contracts:
 * - CRUD operations with all schema fields
 * - Campaign assignment  
 * - On-chain registration
 * - Stats retrieval
 * 
 * All routes require SuperAdmin authentication
 * Mounted at: /api/admin/contracts
 * 
 * ============================================================================
 */

import { Router } from 'express'
import contractService from '../services/contract.service.js'
import { success, created, badRequest, notFound, paginated } from '../utils/response.js'

const router = Router()

/**
 * GET /admin/contracts
 * List all contracts with pagination and filters
 */
router.get('/', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      chainId,
      contractType,
      isActive
    } = req.query
    
    const result = await contractService.getContracts({
      page: parseInt(page),
      limit: parseInt(limit),
      chainId: chainId ? parseInt(chainId) : undefined,
      contractType,
      isActive: isActive !== undefined ? isActive === 'true' : undefined
    })
    
    return paginated(res, result.contracts, {
      page: result.page,
      limit: result.limit,
      total: result.total
    })
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * GET /admin/contracts/:id
 * Get contract details with assigned campaigns
 */
router.get('/:id', async (req, res) => {
  try {
    const contract = await contractService.getContractById(req.params.id)
    return success(res, contract)
  } catch (err) {
    return notFound(res, err.message)
  }
})

/**
 * POST /admin/contracts
 * Create a new contract
 * 
 * Body: {
 *   name: string (required),
 *   address: string (required),
 *   chainId: number,
 *   contractType: string,
 *   privateKey: string,
 *   deployerAddress: string,
 *   deployedAt: string (ISO date),
 *   defaultDestination: string,
 *   description: string,
 *   notes: string
 * }
 */
router.post('/', async (req, res) => {
  try {
    const {
      name,
      description,
      address,
      chainId,
      contractType,
      privateKey,
      deployerAddress,
      deployedAt,
      defaultDestination,
      notes
    } = req.body
    
    if (!name || !address) {
      return badRequest(res, 'Name and address are required')
    }
    
    const contract = await contractService.createContract({
      name,
      description,
      address,
      chainId: chainId || 11155111,
      contractType: contractType || 'router_v1',
      privateKey, // Will be encrypted by service
      deployerAddress,
      deployedAt: deployedAt || null,
      defaultDestination,
      notes
    })
    
    return created(res, contract, 'Contract created successfully')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * PUT /admin/contracts/:id
 * Update contract
 * 
 * Body: Partial contract fields
 */
router.put('/:id', async (req, res) => {
  try {
    // Map camelCase from frontend to snake_case for DB
    const fieldMapping = {
      name: 'name',
      description: 'description',
      isActive: 'is_active',
      is_active: 'is_active',
      defaultDestination: 'default_destination',
      default_destination: 'default_destination',
      deployerAddress: 'deployer_address',
      deployer_address: 'deployer_address',
      deployedAt: 'deployed_at',
      deployed_at: 'deployed_at',
      privateKey: 'private_key',  // Service will encrypt this
      notes: 'notes'
    }
    
    const updates = {}
    
    for (const [frontendKey, dbKey] of Object.entries(fieldMapping)) {
      if (req.body[frontendKey] !== undefined) {
        updates[dbKey] = req.body[frontendKey]
      }
    }
    
    const contract = await contractService.updateContract(req.params.id, updates)
    return success(res, contract, 'Contract updated')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * DELETE /admin/contracts/:id
 * Delete contract (only if no campaigns assigned)
 */
router.delete('/:id', async (req, res) => {
  try {
    await contractService.deleteContract(req.params.id)
    return success(res, null, 'Contract deleted')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * GET /admin/contracts/:id/campaigns
 * Get campaigns assigned to this contract
 */
router.get('/:id/campaigns', async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query
    
    const result = await contractService.getContractCampaigns(req.params.id, {
      page: parseInt(page),
      limit: parseInt(limit)
    })
    
    return paginated(res, result.campaigns, {
      page: result.page,
      limit: result.limit,
      total: result.total
    })
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * POST /admin/contracts/:id/assign
 * Assign a campaign to this contract
 * 
 * Body: { campaignId: string }
 */
router.post('/:id/assign', async (req, res) => {
  try {
    const { campaignId } = req.body
    
    if (!campaignId) {
      return badRequest(res, 'Campaign ID is required')
    }
    
    const campaign = await contractService.assignContractToCampaign(campaignId, req.params.id)
    return success(res, campaign, 'Campaign assigned to contract')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * POST /admin/contracts/:id/unassign
 * Unassign a campaign from this contract
 * 
 * Body: { campaignId: string }
 */
router.post('/:id/unassign', async (req, res) => {
  try {
    const { campaignId } = req.body
    
    if (!campaignId) {
      return badRequest(res, 'Campaign ID is required')
    }
    
    const campaign = await contractService.unassignContractFromCampaign(campaignId)
    return success(res, campaign, 'Campaign unassigned from contract')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * POST /admin/contracts/:contractId/register/:campaignId
 * Register campaign destination on-chain
 */
router.post('/:contractId/register/:campaignId', async (req, res) => {
  try {
    const result = await contractService.registerCampaignOnChain(
      req.params.contractId,
      req.params.campaignId
    )
    
    if (result.alreadyRegistered) {
      return success(res, result, 'Campaign already registered on-chain')
    }
    
    return success(res, result, 'Campaign registered on-chain')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * GET /admin/contracts/:id/stats
 * Get on-chain stats for contract
 */
router.get('/:id/stats', async (req, res) => {
  try {
    const stats = await contractService.getContractOnChainStats(req.params.id)
    return success(res, stats)
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * GET /admin/contracts/:id/spender
 * Get spender address for this contract
 */
router.get('/:id/spender', async (req, res) => {
  try {
    const spender = await contractService.getSpenderAddress(req.params.id)
    return success(res, { spender })
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * POST /admin/contracts/migrate-keys
 * Migrate unencrypted private keys to encrypted format
 * Run once after deploying encryption
 */
router.post('/migrate-keys', async (req, res) => {
  try {
    const result = await contractService.migrateUnencryptedKeys()
    return success(res, result, `Migrated ${result.migrated} keys, skipped ${result.skipped} already encrypted`)
  } catch (err) {
    return badRequest(res, err.message)
  }
})

export default router