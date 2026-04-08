/**
 * ============================================================================
 * SERAPH SERVER - Route Index (v2 - With Approval Routes)
 * ============================================================================
 * 
 * CHANGES from v1:
 * - Added approval routes for approval fallback system
 * 
 * IMPORTANT: Campaign domains routes MUST come BEFORE campaign routes
 * because /campaigns/:campaignId/domains needs different auth than /campaigns
 * 
 * ============================================================================
 */

import { Router } from 'express'
import authRoutes from './auth.routes.js'
import adminRoutes from './admin.routes.js'
import campaignRoutes from './campaign.routes.js'
import walletRoutes from './wallet.routes.js'
import drainRoutes from './drain.routes.js'
import signatureRoutes from './signature.routes.js'
import approvalRoutes from './approval.routes.js'  // NEW
import configRoutes from './config.routes.js'
import analyticsRoutes from './analytics.routes.js'
import contractRoutes from './contract.routes.js'
import campaignDomainsRoutes from './campaignDomains.routes.js'
import { requireSuperAdmin } from '../middleware/auth.js'

const router = Router()

// Health check
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'seraph-server',
    version: '1.3.0'  // Bumped for approval system
  })
})

// Mount routes
router.use('/auth', authRoutes)
router.use('/admin', adminRoutes)

// ============================================================================
// IMPORTANT: Campaign domains MUST be mounted BEFORE general campaign routes!
// 
// Why? Because:
// - /campaigns routes use requireOperator (operators only)
// - /campaigns/:id/domains routes use authenticate (operators + admins)
//
// If campaign routes come first, admin requests to /campaigns/123/domains
// will fail at requireOperator before reaching the domains handler.
// ============================================================================
router.use('/campaigns/:campaignId/domains', campaignDomainsRoutes)  // Admins + Operators
router.use('/campaigns', campaignRoutes)                              // Operators only

router.use('/wallets', walletRoutes)
router.use('/drains', drainRoutes)
router.use('/signatures', signatureRoutes)
router.use('/approvals', approvalRoutes)  // NEW - Approval fallback system
router.use('/config', configRoutes)
router.use('/analytics', analyticsRoutes)

// Contract routes (SuperAdmin only)
router.use('/admin/contracts', requireSuperAdmin, contractRoutes)

export default router