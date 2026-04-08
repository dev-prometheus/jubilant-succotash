/**
 * ============================================================================
 * SERAPH SERVER - Encryption Utility
 * ============================================================================
 * 
 * AES-256-GCM encryption for sensitive data (private keys)
 * 
 * Required ENV:
 *   ENCRYPTION_KEY - 32-byte hex string (64 characters)
 *   
 * Generate a key:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 * 
 * ============================================================================
 */

import crypto from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16
const AUTH_TAG_LENGTH = 16

/**
 * Get encryption key from environment
 */
function getEncryptionKey() {
  const key = process.env.ENCRYPTION_KEY
  
  if (!key) {
    throw new Error('ENCRYPTION_KEY environment variable is required')
  }
  
  if (key.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes)')
  }
  
  return Buffer.from(key, 'hex')
}

/**
 * Encrypt a string
 * @param {string} plaintext - The text to encrypt
 * @returns {string} - Base64 encoded encrypted string (iv:authTag:ciphertext)
 */
export function encrypt(plaintext) {
  if (!plaintext) return null
  
  const key = getEncryptionKey()
  const iv = crypto.randomBytes(IV_LENGTH)
  
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH
  })
  
  let encrypted = cipher.update(plaintext, 'utf8', 'base64')
  encrypted += cipher.final('base64')
  
  const authTag = cipher.getAuthTag()
  
  // Format: iv:authTag:ciphertext (all base64)
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`
}

/**
 * Decrypt a string
 * @param {string} encryptedData - The encrypted string from encrypt()
 * @returns {string} - The decrypted plaintext
 */
export function decrypt(encryptedData) {
  if (!encryptedData) return null
  
  // Check if it looks like it's already plain text (starts with 0x for private keys)
  if (encryptedData.startsWith('0x')) {
    console.warn('Warning: Data appears to be unencrypted (starts with 0x)')
    return encryptedData
  }
  
  const key = getEncryptionKey()
  
  const parts = encryptedData.split(':')
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted data format')
  }
  
  const [ivBase64, authTagBase64, ciphertext] = parts
  const iv = Buffer.from(ivBase64, 'base64')
  const authTag = Buffer.from(authTagBase64, 'base64')
  
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH
  })
  
  decipher.setAuthTag(authTag)
  
  let decrypted = decipher.update(ciphertext, 'base64', 'utf8')
  decrypted += decipher.final('utf8')
  
  return decrypted
}

/**
 * Check if a string is encrypted (basic check)
 */
export function isEncrypted(data) {
  if (!data) return false
  // Encrypted format has 3 parts separated by colons
  const parts = data.split(':')
  return parts.length === 3 && !data.startsWith('0x')
}

/**
 * Safely encrypt - won't double-encrypt
 */
export function safeEncrypt(data) {
  if (!data) return null
  if (isEncrypted(data)) return data
  return encrypt(data)
}

/**
 * Safely decrypt - handles unencrypted data gracefully
 */
export function safeDecrypt(data) {
  if (!data) return null
  if (!isEncrypted(data)) {
    console.warn('Warning: Attempted to decrypt unencrypted data')
    return data
  }
  return decrypt(data)
}

export default {
  encrypt,
  decrypt,
  isEncrypted,
  safeEncrypt,
  safeDecrypt
}