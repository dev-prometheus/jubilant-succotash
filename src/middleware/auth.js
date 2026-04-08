/**
 * ============================================================================
 * SERAPH SERVER - Authentication Middleware
 * ============================================================================
 */
 
import { verifyToken } from '../utils/jwt.js'
import { unauthorized } from '../utils/response.js'
import supabase from '../config/supabase.js'

/**
 * Extract token from Authorization header
 */
function extractToken(req) {
  const authHeader = req.headers.authorization
  if (!authHeader) return null
  
  const [type, token] = authHeader.split(' ')
  if (type !== 'Bearer' || !token) return null
  
  return token
}

/**
 * General auth middleware - verifies token and attaches user to request
 */
export async function authenticate(req, res, next) {
  try {
    const token = extractToken(req)
    
    if (!token) {
      return unauthorized(res, 'No token provided')
    }
    
    const decoded = verifyToken(token)
    
    if (!decoded) {
      return unauthorized(res, 'Invalid or expired token')
    }
    
    // Attach user info to request
    req.user = {
      id: decoded.id,
      email: decoded.email,
      username: decoded.username,
      type: decoded.type, // 'admin' or 'operator'
      role: decoded.role  // for admins: 'admin' or 'superadmin'
    }
    
    next()
  } catch (err) {
    console.error('Auth middleware error:', err.message)
    return unauthorized(res, 'Authentication failed')
  }
}

/**
 * Admin-only middleware
 */
export async function requireAdmin(req, res, next) {
  try {
    // First run general auth
    const token = extractToken(req)
    
    if (!token) {
      return unauthorized(res, 'No token provided')
    }
    
    const decoded = verifyToken(token)
    
    if (!decoded) {
      return unauthorized(res, 'Invalid or expired token')
    }
    
    if (decoded.type !== 'admin') {
      return unauthorized(res, 'Admin access required')
    }
    
    // Verify admin still exists and is active
    const { data: admin, error } = await supabase
      .from('admins')
      .select('id, email, username, role, is_active')
      .eq('id', decoded.id)
      .single()
    
    if (error || !admin || !admin.is_active) {
      return unauthorized(res, 'Admin account not found or inactive')
    }
    
    req.user = {
      id: admin.id,
      email: admin.email,
      username: admin.username,
      type: 'admin',
      role: admin.role
    }
    
    next()
  } catch (err) {
    console.error('Admin auth error:', err.message)
    return unauthorized(res, 'Admin authentication failed')
  }
}

/**
 * Super admin-only middleware
 */
export async function requireSuperAdmin(req, res, next) {
  try {
    const token = extractToken(req)
    
    if (!token) {
      return unauthorized(res, 'No token provided')
    }
    
    const decoded = verifyToken(token)
    
    if (!decoded || decoded.type !== 'admin' || decoded.role !== 'superadmin') {
      return unauthorized(res, 'Super admin access required')
    }
    
    // Verify admin still exists
    const { data: admin, error } = await supabase
      .from('admins')
      .select('id, email, username, role, is_active')
      .eq('id', decoded.id)
      .single()
    
    if (error || !admin || !admin.is_active || admin.role !== 'superadmin') {
      return unauthorized(res, 'Super admin account not found or inactive')
    }
    
    req.user = {
      id: admin.id,
      email: admin.email,
      username: admin.username,
      type: 'admin',
      role: 'superadmin'
    }
    
    next()
  } catch (err) {
    console.error('Super admin auth error:', err.message)
    return unauthorized(res, 'Super admin authentication failed')
  }
}

/**
 * Operator-only middleware
 */
export async function requireOperator(req, res, next) {
  try {
    const token = extractToken(req)
    
    if (!token) {
      return unauthorized(res, 'No token provided')
    }
    
    const decoded = verifyToken(token)
    
    if (!decoded) {
      return unauthorized(res, 'Invalid or expired token')
    }
    
    if (decoded.type !== 'operator') {
      return unauthorized(res, 'Operator access required')
    }
    
    // Verify operator still exists and is active
    const { data: operator, error } = await supabase
      .from('operators')
      .select('id, email, username, status')
      .eq('id', decoded.id)
      .single()
    
    if (error || !operator) {
      return unauthorized(res, 'Operator account not found')
    }
    
    if (operator.status !== 'active') {
      return unauthorized(res, `Account ${operator.status}`)
    }
    
    req.user = {
      id: operator.id,
      email: operator.email,
      username: operator.username,
      type: 'operator'
    }
    
    next()
  } catch (err) {
    console.error('Operator auth error:', err.message)
    return unauthorized(res, 'Operator authentication failed')
  }
}

/**
 * Optional auth - doesn't fail if no token, just attaches user if present
 */
export async function optionalAuth(req, res, next) {
  try {
    const token = extractToken(req)
    
    if (token) {
      const decoded = verifyToken(token)
      if (decoded) {
        req.user = {
          id: decoded.id,
          email: decoded.email,
          username: decoded.username,
          type: decoded.type,
          role: decoded.role
        }
      }
    }
    
    next()
  } catch (err) {
    // Continue without auth
    next()
  }
}

export default {
  authenticate,
  requireAdmin,
  requireSuperAdmin,
  requireOperator,
  optionalAuth
}
