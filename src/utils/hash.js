/**
 * ============================================================================
 * SERAPH SERVER - Password Hashing
 * ============================================================================
 */

import bcrypt from 'bcryptjs'

const SALT_ROUNDS = 10

/**
 * Hash a password
 */
export async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS)
}

/**
 * Verify a password against hash
 */
export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash)
}

export default { hashPassword, verifyPassword }
