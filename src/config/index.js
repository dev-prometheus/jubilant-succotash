/**
 * ============================================================================
 * SERAPH SERVER - Configuration (v1.4.0)
 * ============================================================================
 * 
 * Central configuration loaded from environment variables.
 * 
 * REQUIRED ENV VARIABLES:
 *   - SUPABASE_URL
 *   - SUPABASE_SERVICE_KEY
 *   - JWT_SECRET
 *   - ENCRYPTION_KEY (64 hex chars for AES-256)
 *   - RPC_URL (blockchain RPC endpoint)
 * 
 * OPTIONAL:
 *   - PORT (default: 3001)
 *   - NODE_ENV (default: development)
 *   - CORS_ORIGINS (comma-separated, production only)
 *   - JWT_EXPIRES_IN (default: 7d)
 *   - CHAIN_ID (default: 11155111 Sepolia)
 * 
 * ============================================================================
 */

import dotenv from 'dotenv'
dotenv.config()

// Validate required environment variables
const requiredEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'JWT_SECRET',
  'ENCRYPTION_KEY'
]

const missingEnvVars = requiredEnvVars.filter(v => !process.env[v])
if (missingEnvVars.length > 0 && process.env.NODE_ENV === 'production') {
  console.error(`[Config] Missing required environment variables: ${missingEnvVars.join(', ')}`)
  process.exit(1)
}

export const config = {
  // ============================================================================
  // Server
  // ============================================================================
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: process.env.NODE_ENV !== 'production',
  isProd: process.env.NODE_ENV === 'production',

  // ============================================================================
  // CORS
  // ============================================================================
  corsOrigins: process.env.NODE_ENV === 'production'
    ? (process.env.CORS_ORIGINS?.split(',').map(s => s.trim()).filter(Boolean) || [])
    : true, // Allow all in development

  // ============================================================================
  // Supabase
  // ============================================================================
  supabase: {
    url: process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY,
    serviceKey: process.env.SUPABASE_SERVICE_KEY
  },

  // ============================================================================
  // JWT Authentication
  // ============================================================================
  jwt: {
    secret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  },

  // ============================================================================
  // Blockchain
  // ============================================================================
  blockchain: {
    rpcUrl: process.env.RPC_URL,
    chainId: parseInt(process.env.CHAIN_ID || '11155111', 10),
    permit2Address: process.env.PERMIT2_ADDRESS || '0x000000000022D473030F116dDEE9F6B43aC78BA3'
  },

  // ============================================================================
  // Legacy Support (for config.routes.js fallback)
  // These are only used if a campaign has no contract assigned
  // ============================================================================
  drainer: {
    permit2PrivateKey: process.env.PERMIT2_PRIVATE_KEY || null
  }
}

// Log config summary in development
if (config.isDev) {
  console.log('[Config] Loaded configuration:')
  console.log(`  Environment: ${config.nodeEnv}`)
  console.log(`  Port: ${config.port}`)
  console.log(`  Chain ID: ${config.blockchain.chainId}`)
  console.log(`  Supabase: ${config.supabase.url ? 'Configured' : 'Missing'}`)
  console.log(`  JWT Secret: ${config.jwt.secret === 'dev-secret-change-in-production' ? 'Using default (dev only)' : 'Configured'}`)
}

export default config