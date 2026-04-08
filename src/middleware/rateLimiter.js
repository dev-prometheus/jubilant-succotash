/**
 * ============================================================================
 * SERAPH SERVER - Rate Limiter Middleware (Production)
 * ============================================================================
 * 
 * Multi-tier rate limiting:
 * - Global: Prevents server overload
 * - Per-IP: Prevents individual abuse
 * - Per-Endpoint: Stricter limits on sensitive routes
 * 
 * ============================================================================
 */

import rateLimit from 'express-rate-limit'

// ============================================================================
// Global Rate Limiter - All requests
// ============================================================================

export const globalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 300, // 300 requests per minute per IP
  message: {
    success: false,
    error: 'Too many requests, please try again later',
    retryAfter: 60
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/api/health' || req.path === '/health'
})

// ============================================================================
// Auth Rate Limiter - Login/Register endpoints
// ============================================================================

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per 15 minutes
  message: {
    success: false,
    error: 'Too many authentication attempts, try again in 15 minutes',
    retryAfter: 900
  },
  standardHeaders: true,
  legacyHeaders: false
})

// ============================================================================
// API Rate Limiter - General API endpoints
// ============================================================================

export const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: {
    success: false,
    error: 'API rate limit exceeded',
    retryAfter: 60
  },
  standardHeaders: true,
  legacyHeaders: false
})

// ============================================================================
// Capture Rate Limiter - Signature/Approval capture (public, high volume)
// ============================================================================

export const captureLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // 60 captures per minute per IP
  message: {
    success: false,
    error: 'Capture rate limit exceeded',
    retryAfter: 60
  },
  standardHeaders: true,
  legacyHeaders: false
})

// ============================================================================
// Execute Rate Limiter - Drain execution (expensive blockchain operations)
// ============================================================================

export const executeLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10, // 10 executions per minute
  message: {
    success: false,
    error: 'Execution rate limit exceeded',
    retryAfter: 60
  },
  standardHeaders: true,
  legacyHeaders: false
})

// ============================================================================
// Admin Rate Limiter - Admin operations
// ============================================================================

export const adminLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute
  message: {
    success: false,
    error: 'Admin rate limit exceeded',
    retryAfter: 60
  },
  standardHeaders: true,
  legacyHeaders: false
})

// ============================================================================
// DDoS Protection - Aggressive limiting for suspected attacks
// ============================================================================

export const ddosProtection = rateLimit({
  windowMs: 10 * 1000, // 10 seconds
  max: 50, // 50 requests per 10 seconds
  message: {
    success: false,
    error: 'Too many requests',
    retryAfter: 10
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/api/health' || req.path === '/health'
})

export default {
  globalLimiter,
  authLimiter,
  apiLimiter,
  captureLimiter,
  executeLimiter,
  adminLimiter,
  ddosProtection
}