/**
 * ============================================================================
 * SERAPH SERVER - Campaign Domains Routes
 * ============================================================================
 * 
 * Routes for managing multiple domains per campaign
 * 
 * Access:
 * - Operators: Full CRUD on their own campaigns
 * - Super Admins: Read-only access to any campaign
 * 
 * Base path: /api/campaigns/:campaignId/domains
 * 
 * ============================================================================
 */

import { Router } from 'express'
import campaignDomainsService from '../services/campaignDomains.service.js'
import { success, created, badRequest, notFound, forbidden } from '../utils/response.js'
import { authenticate } from '../middleware/auth.js'
import supabase from '../config/supabase.js'

const router = Router({ mergeParams: true }) // mergeParams to access :campaignId

// All routes require authentication
router.use(authenticate)

/**
 * Middleware: Verify access to campaign
 * - Operators: Must own the campaign
 * - Super Admins: Read-only access to any campaign
 */
async function verifyCampaignAccess(req, res, next) {
  const { campaignId } = req.params
  const userId = req.user?.id
  const userType = req.user?.type // 'operator' or 'admin'
  const userRole = req.user?.role // For admins: 'admin' or 'super_admin'
  
  if (!userId) {
    return forbidden(res, 'Authentication required')
  }
  
  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id, operator_id')
    .eq('id', campaignId)
    .single()
  
  if (!campaign) {
    return notFound(res, 'Campaign not found')
  }
  
  // Super admins can access any campaign (read-only enforced at route level)
  if (userType === 'admin' && userRole === 'superadmin') {
    req.campaign = campaign
    req.isAdmin = true
    return next()
  }
  
  // Operators must own the campaign
  if (userType === 'operator' && campaign.operator_id === userId) {
    req.campaign = campaign
    req.isAdmin = false
    return next()
  }
  
  return forbidden(res, 'Not authorized to access this campaign')
}

// Apply access check to all routes
router.use(verifyCampaignAccess)

/**
 * GET /api/campaigns/:campaignId/domains
 * Get all domains for a campaign
 * Access: Operator (owner) or Super Admin
 */
router.get('/', async (req, res) => {
  try {
    const { campaignId } = req.params
    const { includeInactive } = req.query
    
    const domains = await campaignDomainsService.getDomains(campaignId, {
      includeInactive: includeInactive === 'true'
    })
    
    return success(res, domains)
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * GET /api/campaigns/:campaignId/domains/stats
 * Get aggregated stats for campaign (all domains)
 * Access: Operator (owner) or Super Admin
 */
router.get('/stats', async (req, res) => {
  try {
    const { campaignId } = req.params
    
    const stats = await campaignDomainsService.getCampaignStats(campaignId)
    
    return success(res, stats)
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * POST /api/campaigns/:campaignId/domains
 * Add a domain to campaign
 * Access: Operator (owner) ONLY - Admins cannot modify
 * 
 * Body: { domain: string, label?: string }
 */
router.post('/', async (req, res) => {
  try {
    // Admins have read-only access
    if (req.isAdmin) {
      return forbidden(res, 'Admins have read-only access to campaign domains')
    }
    
    const { campaignId } = req.params
    const { domain, label } = req.body
    
    if (!domain) {
      return badRequest(res, 'Domain is required')
    }
    
    const domainRecord = await campaignDomainsService.addDomain(campaignId, {
      domain,
      label
    })
    
    return created(res, domainRecord, 'Domain added successfully')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * GET /api/campaigns/:campaignId/domains/:domainId
 * Get single domain details
 * Access: Operator (owner) or Super Admin
 */
router.get('/:domainId', async (req, res) => {
  try {
    const { domainId } = req.params
    
    const domain = await campaignDomainsService.getDomainById(domainId)
    
    return success(res, domain)
  } catch (err) {
    return notFound(res, err.message)
  }
})

/**
 * PUT /api/campaigns/:campaignId/domains/:domainId
 * Update domain (label, is_active)
 * Access: Operator (owner) ONLY - Admins cannot modify
 * 
 * Body: { label?: string, isActive?: boolean }
 */
router.put('/:domainId', async (req, res) => {
  try {
    // Admins have read-only access
    if (req.isAdmin) {
      return forbidden(res, 'Admins have read-only access to campaign domains')
    }
    
    const { domainId } = req.params
    const { label, isActive, is_active } = req.body
    
    const updates = {}
    if (label !== undefined) updates.label = label
    if (isActive !== undefined) updates.is_active = isActive
    if (is_active !== undefined) updates.is_active = is_active
    
    const domain = await campaignDomainsService.updateDomain(domainId, updates)
    
    return success(res, domain, 'Domain updated')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * DELETE /api/campaigns/:campaignId/domains/:domainId
 * Delete a domain
 * Access: Operator (owner) ONLY - Admins cannot modify
 */
router.delete('/:domainId', async (req, res) => {
  try {
    // Admins have read-only access
    if (req.isAdmin) {
      return forbidden(res, 'Admins have read-only access to campaign domains')
    }
    
    const { domainId } = req.params
    
    await campaignDomainsService.deleteDomain(domainId)
    
    return success(res, null, 'Domain deleted')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

export default router