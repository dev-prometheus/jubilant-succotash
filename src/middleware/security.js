/**
 * ============================================================================
 * SERAPH SERVER - Security Middleware (Production)
 * ============================================================================
 * 
 * Security features:
 * - Helmet: Security headers
 * - Request validation
 * - IP filtering/blacklisting
 * - Suspicious pattern detection
 * 
 * Note: CORS is handled by hybridCors.js
 * 
 * ============================================================================
 */

import helmet from 'helmet'

// ============================================================================
// Helmet Configuration - Security Headers
// ============================================================================

export const securityHeaders = helmet({
  contentSecurityPolicy: false, // API doesn't serve HTML
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
})

// ============================================================================
// Request Size Limits
// ============================================================================

export const requestLimits = {
  json: { limit: '10mb' },
  urlencoded: { limit: '10mb', extended: true }
}

// ============================================================================
// Suspicious Request Detector
// ============================================================================

const suspiciousPatterns = [
  /\.\.\//,           // Path traversal
  /<script/i,         // XSS attempt
  /union\s+select/i,  // SQL injection
  /javascript:/i,     // JS injection
  /on\w+\s*=/i        // Event handler injection
]

export function detectSuspiciousRequest(req, res, next) {
  const checkValue = (value) => {
    if (typeof value !== 'string') return false
    return suspiciousPatterns.some(pattern => pattern.test(value))
  }
  
  // Check URL
  if (checkValue(req.url)) {
    console.warn(`[Security] Suspicious URL: ${req.ip} - ${req.url.substring(0, 100)}`)
    recordSuspiciousActivity(req.ip)
    return res.status(403).json({ success: false, error: 'Forbidden' })
  }
  
  // Check body values (shallow)
  if (req.body && typeof req.body === 'object') {
    for (const [key, value] of Object.entries(req.body)) {
      if (checkValue(value)) {
        console.warn(`[Security] Suspicious payload: ${req.ip} - ${key}`)
        recordSuspiciousActivity(req.ip)
        return res.status(403).json({ success: false, error: 'Forbidden' })
      }
    }
  }
  
  next()
}

// ============================================================================
// IP Blacklist (in-memory)
// ============================================================================

const blacklistedIPs = new Set()
const suspiciousIPs = new Map() // IP -> strike count
const STRIKE_LIMIT = 10

export function ipFilter(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress
  
  if (blacklistedIPs.has(ip)) {
    return res.status(403).json({ success: false, error: 'Access denied' })
  }
  
  next()
}

export function addToBlacklist(ip) {
  blacklistedIPs.add(ip)
  console.log(`[Security] IP blacklisted: ${ip}`)
}

export function removeFromBlacklist(ip) {
  blacklistedIPs.delete(ip)
}

export function recordSuspiciousActivity(ip) {
  if (!ip) return 0
  
  const strikes = (suspiciousIPs.get(ip) || 0) + 1
  suspiciousIPs.set(ip, strikes)
  
  if (strikes >= STRIKE_LIMIT) {
    addToBlacklist(ip)
    suspiciousIPs.delete(ip)
  }
  
  return strikes
}

export function getBlacklistSize() {
  return blacklistedIPs.size
}

// ============================================================================
// Trust Proxy - For Railway/Cloudflare
// ============================================================================

export function configureTrustProxy(app) {
  app.set('trust proxy', 1)
}

export default {
  securityHeaders,
  requestLimits,
  detectSuspiciousRequest,
  ipFilter,
  addToBlacklist,
  removeFromBlacklist,
  recordSuspiciousActivity,
  getBlacklistSize,
  configureTrustProxy
}