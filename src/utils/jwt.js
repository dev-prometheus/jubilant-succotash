/**
 * ============================================================================
 * SERAPH SERVER - JWT Utilities
 * ============================================================================
 */

import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { config } from '../config/index.js'

/**
 * Generate JWT token
 */
export function generateToken(payload) {
  return jwt.sign(payload, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn
  })
}

/**
 * Verify JWT token
 */
export function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwt.secret)
  } catch (err) {
    return null
  }
}

/**
 * Decode token without verification (for debugging)
 */
export function decodeToken(token) {
  return jwt.decode(token)
}

/**
 * Hash a token (for storing in DB)
 */
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

/**
 * Generate random API key
 */
export function generateApiKey() {
  return crypto.randomBytes(32).toString('hex')
}

/**
 * Generate random campaign key
 */
export function generateCampaignKey() {
  return crypto.randomBytes(16).toString('hex')
}

export default {
  generateToken,
  verifyToken,
  decodeToken,
  hashToken,
  generateApiKey,
  generateCampaignKey
}
