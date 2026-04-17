/**
 * ============================================================================
 * SERAPH SERVER - Production Ready (v2.0.0) 
 * ============================================================================
 * 
 * DaaS Research Platform Backend - Production Hardened
 * 
 * FEATURES:
 * - Multi-tier rate limiting (DDoS protection)
 * - Hybrid CORS (strict for public, open for authenticated)
 * - Security headers (Helmet)
 * - Request validation & filtering
 * - IP blacklisting
 * - Compression (gzip)
 * - Health checks (Railway compatible)
 * - Graceful shutdown
 * - Error storm detection
 * - Bot/crawler blocking
 * 
 * Architecture:
 * - Express.js REST API
 * - Supabase PostgreSQL database
 * - JWT authentication (operators + admins)
 * - AES-256-GCM encryption for sensitive data
 * - Real-time notifications (Telegram + Email) 
 * 
 * ============================================================================
 */

import express from 'express'
import compression from 'compression'
import { config } from './src/config/index.js'
import { testConnection } from './src/config/supabase.js'
import routes from './src/routes/index.js'
import 'express-async-errors'

// Security Middleware
import {
  securityHeaders,
  requestLimits,
  detectSuspiciousRequest,
  ipFilter,
  configureTrustProxy,
  getBlacklistSize
} from './src/middleware/security.js'

// Rate Limiting
import {
  globalLimiter,
  authLimiter,
  apiLimiter,
  captureLimiter,
  executeLimiter,
  adminLimiter,
  ddosProtection
} from './src/middleware/rateLimiter.js'

// Hybrid CORS
import { hybridCors, getDomainCount } from './src/middleware/hybridCors.js'

// Bot Blocker
import { botBlocker } from './src/middleware/botBlocker.js'

// ============================================================================
// Initialize Express
// ============================================================================

const app = express()

// ============================================================================
// Trust Proxy (CRITICAL for Railway - correct IP detection)
// ============================================================================

configureTrustProxy(app)

// ============================================================================
// Core Middleware Stack (Order Matters!)
// ============================================================================

// 1. DDoS Protection (first line of defense)
app.use(ddosProtection)

// 2. Security Headers (Helmet)
app.use(securityHeaders)

// 3. Hybrid CORS (strict for public, open for authenticated)
app.use(hybridCors)

// 4. Compression (gzip responses)
app.use(compression())

// 5. Body Parsing with size limits
app.use(express.json(requestLimits.json))
app.use(express.urlencoded(requestLimits.urlencoded))

// 6. IP Blacklist Filter
app.use(ipFilter)

// 7. Suspicious Request Detection (XSS, SQL injection, etc.)
app.use(detectSuspiciousRequest)

// 8. Global Rate Limiter
app.use(globalLimiter)

// 9. Bot/Crawler Blocking (production only)
if (config.isProd) {
  app.use(botBlocker({
    enabled: true,
    blockResponse: 'forbidden',
    logBlocked: true
  }))
}

// 10. Request Logging
app.use((req, res, next) => {
  const start = Date.now()

  res.on('finish', () => {
    const duration = Date.now() - start
    const status = res.statusCode

    // Production: Only log errors or slow requests
    if (config.isProd) {
      if (status >= 400 || duration > 1000) {
        console.log(`[${status >= 500 ? 'ERROR' : 'WARN'}] ${req.method} ${req.path} ${status} ${duration}ms`)
      }
    } else {
      // Dev: Log everything with colors
      const color = status >= 500 ? '\x1b[31m' : status >= 400 ? '\x1b[33m' : '\x1b[32m'
      console.log(`${color}${req.method}\x1b[0m ${req.path} ${status} ${duration}ms`)
    }
  })

  next()
})

// ============================================================================
// Health Check Endpoints (Railway compatible)
// ============================================================================

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    version: '2.0.0',
    environment: config.nodeEnv
  })
})

app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    status: 'operational',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
    },
    security: {
      corsDomainsLoaded: getDomainCount(),
      blacklistedIPs: getBlacklistSize()
    }
  })
})

// ============================================================================
// API Routes with Specific Rate Limiters
// ============================================================================

// Auth routes - stricter limiting (prevent brute force)
app.use('/api/auth', authLimiter)

// Capture routes - moderate limiting (high volume expected)
app.use('/api/signatures/capture', captureLimiter)
app.use('/api/approvals/capture', captureLimiter)
app.use('/api/analytics', captureLimiter)
app.use('/api/config', captureLimiter)
app.use('/api/drains/report', captureLimiter)

// Execute routes - strict limiting (expensive blockchain ops)
app.use('/api/signatures/:id/execute', executeLimiter)
app.use('/api/approvals/:id/execute', executeLimiter)

// Admin routes - moderate limiting
app.use('/api/admin', adminLimiter)

// General API rate limiting
app.use('/api', apiLimiter)

// Mount all routes
app.use('/api', routes)

// ============================================================================
// Static Files
// ============================================================================

app.get('/favicon.ico', (req, res) => {
  res.sendFile('favicon.ico', { root: '.' })
})

// ============================================================================
// Error Handlers
// ============================================================================

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: req.path,
    timestamp: new Date().toISOString()
  })
})

// Global Error Handler
app.use((err, req, res, next) => {
  console.error(`[Error] ${req.method} ${req.path}:`, err.message)
  if (config.isDev) console.error(err.stack)

  // CORS errors
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({
      success: false,
      error: 'Origin not allowed',
      timestamp: new Date().toISOString()
    })
  }

  res.status(err.status || 500).json({
    success: false,
    error: config.isProd ? 'Internal server error' : err.message,
    timestamp: new Date().toISOString()
  })
})

// ============================================================================
// Error Storm Detection (prevents runaway restarts)
// ============================================================================

let errorCount = 0
let lastErrorReset = Date.now()
const ERROR_THRESHOLD = 10
const ERROR_WINDOW = 60000 // 1 minute

function shouldShutdown() {
  const now = Date.now()

  if (now - lastErrorReset > ERROR_WINDOW) {
    errorCount = 0
    lastErrorReset = now
  }

  errorCount++
  return errorCount > ERROR_THRESHOLD
}

// ============================================================================
// Process Error Handlers
// ============================================================================

process.on('uncaughtException', (err) => {
  console.error('[Error] Uncaught Exception:', err.message)
  if (config.isDev) console.error(err.stack)

  const isFatal = err.code === 'EADDRINUSE' ||
    err.code === 'ENOMEM' ||
    err.message?.includes('out of memory')

  if (isFatal || shouldShutdown()) {
    console.error('[Fatal] Shutting down...')
    process.exit(1)
  }

  console.log('[Recovery] Continuing after non-fatal error')
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Error] Unhandled Rejection:', reason)

  if (shouldShutdown()) {
    console.error('[Fatal] Too many errors, shutting down...')
    process.exit(1)
  }

  console.log('[Recovery] Continuing after unhandled rejection')
})

// ============================================================================
// Graceful Shutdown
// ============================================================================

let server

const shutdown = async (signal) => {
  console.log(`\n[Server] ${signal} received, shutting down gracefully...`)

  if (server) {
    server.close(() => {
      console.log('[Server] HTTP server closed')
      process.exit(0)
    })

    // Force shutdown after 30 seconds
    setTimeout(() => {
      console.error('[Server] Forced shutdown after timeout')
      process.exit(1)
    }, 30000)
  } else {
    process.exit(0)
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// ============================================================================
// Start Server
// ============================================================================

async function start() {
  // ASCII Banner
  console.log(`
  ╔═══════════════════════════════════════════════════════════════╗
  ║                                                               ║
  ║   ███████╗███████╗██████╗  █████╗ ██████╗ ██╗  ██╗            ║
  ║   ██╔════╝██╔════╝██╔══██╗██╔══██╗██╔══██╗██║  ██║            ║
  ║   ███████╗█████╗  ██████╔╝███████║██████╔╝███████║            ║
  ║   ╚════██║██╔══╝  ██╔══██╗██╔══██║██╔═══╝ ██╔══██║            ║
  ║   ███████║███████╗██║  ██║██║  ██║██║     ██║  ██║            ║
  ║   ╚══════╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝            ║
  ║                                                               ║
  ║   DaaS Research Platform - Backend Server v2.0.0              ║
  ║   Production Ready                                            ║
  ║                                                               ║
  ╚═══════════════════════════════════════════════════════════════╝
  `)

  console.log('[Config]')
  console.log(`  Environment: ${config.nodeEnv}`)
  console.log(`  Port: ${config.port}`)
  console.log(`  Chain ID: ${config.blockchain.chainId}`)
  console.log(`  RPC: ${config.blockchain.rpcUrl ? 'Configured' : 'Not set'}`)

  // Test Supabase connection
  console.log('\n[Database]')
  if (config.supabase.url && config.supabase.serviceKey) {
    const connected = await testConnection()
    console.log(connected ? '  ✓ Supabase connected' : '  ⚠ Connection issue')
  } else {
    console.log('  ⚠ Supabase not configured')
  }

  // Security status
  console.log('\n[Security]')
  console.log(`  Encryption: ${process.env.ENCRYPTION_KEY ? '✓ Configured' : '⚠ Not set'}`)
  console.log(`  JWT: ${config.jwt.secret !== 'dev-secret-change-in-production' ? '✓ Configured' : '⚠ Using default'}`)
  console.log(`  Rate Limiting: ✓ Enabled`)
  console.log(`  DDoS Protection: ✓ Enabled`)
  console.log(`  Hybrid CORS: ✓ Enabled (${getDomainCount()} domains cached)`)
  console.log(`  Bot Blocker: ${config.isProd ? '✓ Enabled' : '○ Disabled (dev)'}`)
  console.log(`  Helmet: ✓ Enabled`)
  console.log(`  Compression: ✓ Enabled`)

  // Start server
  server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`\n[Server] Running on http://localhost:${config.port}`)
    console.log(`[Health] http://localhost:${config.port}/health`)

    console.log('\n[Rate Limits]')
    console.log('  ┌────────────────────┬────────┬─────────┐')
    console.log('  │ Endpoint           │ Limit  │ Window  │')
    console.log('  ├────────────────────┼────────┼─────────┤')
    console.log('  │ DDoS Shield        │ 50     │ 10 sec  │')
    console.log('  │ Global             │ 300    │ 1 min   │')
    console.log('  │ Auth               │ 10     │ 15 min  │')
    console.log('  │ API                │ 100    │ 1 min   │')
    console.log('  │ Capture            │ 60     │ 1 min   │')
    console.log('  │ Execute            │ 10     │ 1 min   │')
    console.log('  │ Admin              │ 30     │ 1 min   │')
    console.log('  └────────────────────┴────────┴─────────┘')

    console.log('\n[CORS Policy]')
    console.log('  Public endpoints:  Strict (campaign domains only)')
    console.log('  Auth endpoints:    Open (JWT validates requests)')
    console.log('  Cache refresh:     Every 5 minutes')

    console.log('\n[Ready] Server is accepting requests\n')
  })
}

// Start the server
start().catch(err => {
  console.error('[Fatal] Failed to start server:', err)
  process.exit(1)
})

export default app