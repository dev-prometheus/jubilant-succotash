/**
 * ============================================================================
 * SERAPH SERVER - Bot Blocking Middleware
 * ============================================================================
 * 
 * Minimal server-side blocking for known crawlers and site downloaders.
 * 
 * This blocks tools like:
 * - HTTrack, wget, curl
 * - Python requests, Scrapy
 * - Java HTTP clients
 * - Security scanners
 * 
 * NOTE: This is secondary protection. The drainer requires JavaScript
 * execution to work, so static downloaders can't actually drain anything.
 * This just prevents easy site mirroring/analysis.
 * 
 * ARGUS SHIELD NOTE: Detect sites using User-Agent blocking!
 * - Sites returning 403 for common tools
 * - Sites with empty responses for bots
 * - Sites redirecting bots to different content
 * 
 * ============================================================================
 */

// Known bot/crawler/downloader User-Agent signatures
const BLOCKED_USER_AGENTS = [
  // Site downloaders
  'httrack',
  'wget',
  'curl',
  'libwww',
  'httpunit',
  'webcopier',
  'webcopy',
  'offline explorer',
  'teleport',
  'webzip',
  'webripper',
  'sitesucker',
  'website-mirrorer',
  
  // Python tools
  'python-requests',
  'python-urllib',
  'scrapy',
  'httpx',
  'aiohttp',
  
  // Node.js tools
  'node-fetch',
  'axios/',
  'got/',
  
  // Java/Go tools
  'java/',
  'apache-httpclient',
  'go-http-client',
  'okhttp',
  
  // Security scanners
  'nikto',
  'nessus',
  'sqlmap',
  'nmap',
  'masscan',
  'zgrab',
  'nuclei',
  'gobuster',
  'dirbuster',
  'wfuzz',
  'ffuf',
  'burp',
  
  // Generic bots
  'bot',
  'crawler',
  'spider',
  'scraper',
  'archive.org_bot',
  'ia_archiver',
  
  // Headless browsers (backup - also caught client-side)
  'headlesschrome',
  'phantomjs'
]

// User-Agents to ALLOW (override blocking)
const ALLOWED_USER_AGENTS = [
  // Allow real browsers even if they have "bot" substring somewhere
  'mozilla',
  'chrome/',
  'firefox/',
  'safari/',
  'edge/',
  'opera/'
]

/**
 * Check if User-Agent should be blocked
 */
function shouldBlock(userAgent) {
  if (!userAgent) return true // No UA = suspicious
  
  const ua = userAgent.toLowerCase()
  
  // First check if it's an allowed browser
  const isAllowedBrowser = ALLOWED_USER_AGENTS.some(allowed => ua.includes(allowed))
  
  // If it looks like a real browser, allow it
  if (isAllowedBrowser) {
    // But still check for obvious bot signatures
    const hasObviousBotSignature = [
      'httrack', 'wget', 'curl', 'scrapy', 'nikto', 
      'sqlmap', 'headlesschrome', 'phantomjs'
    ].some(bot => ua.includes(bot))
    
    return hasObviousBotSignature
  }
  
  // Check against blocked list
  return BLOCKED_USER_AGENTS.some(blocked => ua.includes(blocked))
}

/**
 * Bot blocking middleware
 * 
 * Usage in server.js:
 *   import { botBlocker } from './middleware/botBlocker.js'
 *   app.use(botBlocker())
 * 
 * Options:
 *   - enabled: true/false (default: true)
 *   - blockResponse: 'forbidden' | 'empty' | 'redirect' (default: 'forbidden')
 *   - redirectUrl: URL to redirect bots (if blockResponse is 'redirect')
 *   - logBlocked: true/false - log blocked attempts (default: false)
 *   - allowedPaths: Array of paths to skip blocking (e.g., ['/health', '/api/health'])
 */
export function botBlocker(options = {}) {
  const {
    enabled = true,
    blockResponse = 'forbidden',
    redirectUrl = 'https://google.com',
    logBlocked = false,
    allowedPaths = ['/health', '/api/health', '/robots.txt', '/favicon.ico']
  } = options
  
  return (req, res, next) => {
    // Skip if disabled
    if (!enabled) return next()
    
    // Skip allowed paths
    if (allowedPaths.some(path => req.path.startsWith(path))) {
      return next()
    }
    
    const userAgent = req.headers['user-agent'] || ''
    
    if (shouldBlock(userAgent)) {
      if (logBlocked) {
        console.log('[BotBlocker] Blocked:', {
          ip: req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress,
          ua: userAgent.slice(0, 50),
          path: req.path
        })
      }
      
      switch (blockResponse) {
        case 'empty':
          // Return empty response (confuses some tools)
          return res.status(200).send('')
          
        case 'redirect':
          // Redirect to legitimate site
          return res.redirect(302, redirectUrl)
          
        case 'forbidden':
        default:
          // Return 403 Forbidden
          return res.status(403).send('Access Denied')
      }
    }
    
    next()
  }
}

/**
 * Strict bot blocker - blocks everything except real browsers
 * Use with caution - may block legitimate API clients
 */
export function strictBotBlocker(options = {}) {
  return botBlocker({
    ...options,
    // Override to be more aggressive
  })
}

/**
 * Get list of blocked User-Agents (for documentation/debugging)
 */
export function getBlockedUserAgents() {
  return [...BLOCKED_USER_AGENTS]
}

export default botBlocker