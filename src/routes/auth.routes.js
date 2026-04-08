/**
 * ============================================================================
 * SERAPH SERVER - Auth Routes
 * ============================================================================
 */

import { Router } from 'express'
import authService from '../services/auth.service.js'
import operatorService from '../services/operator.service.js'
import { authenticate, requireOperator, requireAdmin, requireSuperAdmin } from '../middleware/auth.js'
import { success, created, badRequest, unauthorized } from '../utils/response.js'
import supabase from '../config/supabase.js'

const router = Router()

/**
 * POST /auth/login
 * Login for operators
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body
    
    if (!email || !password) {
      return badRequest(res, 'Email and password are required')
    }
    
    const result = await authService.loginOperator({ email, password })
    
    return success(res, result, 'Login successful')
  } catch (err) {
    return unauthorized(res, err.message)
  }
})

/**
 * POST /auth/admin/login
 * Login for admins
 */
router.post('/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body
    
    if (!email || !password) {
      return badRequest(res, 'Email and password are required')
    }
    
    const result = await authService.loginAdmin({ email, password })
    
    return success(res, result, 'Admin login successful')
  } catch (err) {
    return unauthorized(res, err.message)
  }
})

/**
 * GET /auth/profile
 * Get current user profile (includes notification settings for operators)
 */
router.get('/profile', authenticate, async (req, res) => {
  try {
    // For operators, fetch fresh data including notification settings
    if (req.user.type === 'operator') {
      const { data, error } = await supabase
        .from('operators')
        .select(`
          id, email, username, status, api_key,
          telegram_chat_id, notification_email,
          telegram_notifications, email_notifications,
          total_campaigns, total_drains, total_value_usd,
          created_at, last_login
        `)
        .eq('id', req.user.id)
        .single()
      
      if (error) throw error
      
      return success(res, { ...data, type: 'operator' })
    }
    
    // For admins
    if (req.user.type === 'admin') {
      const { data, error } = await supabase
        .from('admins')
        .select('id, email, username, role, created_at, last_login')
        .eq('id', req.user.id)
        .single()
      
      if (error) throw error
      
      return success(res, { ...data, type: 'admin' })
    }
    
    // Fallback to token data
    return success(res, req.user)
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * PUT /auth/settings
 * Update operator's own notification settings (self-service)
 */
router.put('/settings', requireOperator, async (req, res) => {
  try {
    const operator = await operatorService.updateOwnSettings(req.user.id, req.body)
    return success(res, operator, 'Settings updated')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * PUT /auth/password
 * Update password
 */
router.put('/password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body
    
    if (!currentPassword || !newPassword) {
      return badRequest(res, 'Current and new password are required')
    }
    
    if (newPassword.length < 8) {
      return badRequest(res, 'New password must be at least 8 characters')
    }
    
    await authService.updatePassword(
      req.user.id,
      req.user.type,
      currentPassword,
      newPassword
    )
    
    return success(res, null, 'Password updated successfully')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * POST /auth/admin/create
 * Create a new admin (super admin only)
 */
router.post('/admin/create', requireSuperAdmin, async (req, res) => {
  try {
    const { email, username, password, role = 'admin' } = req.body
    
    if (!email || !username || !password) {
      return badRequest(res, 'Email, username, and password are required')
    }
    
    const admin = await authService.createAdmin({ email, username, password, role })
    
    return created(res, admin, 'Admin created successfully')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

export default router