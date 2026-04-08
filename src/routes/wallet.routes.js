/**
 * ============================================================================
 * SERAPH SERVER - Wallet Routes (Operator)
 * ============================================================================
 */

import { Router } from 'express'
import { requireOperator } from '../middleware/auth.js'
import walletService from '../services/wallet.service.js'
import { success, created, badRequest, notFound } from '../utils/response.js'

const router = Router()

// All routes require operator auth
router.use(requireOperator)

/**
 * GET /wallets
 * List operator's wallets
 */
router.get('/', async (req, res) => {
  try {
    const { chainId } = req.query
    
    const wallets = await walletService.getWallets(req.user.id, {
      chainId: chainId ? parseInt(chainId) : undefined
    })
    
    return success(res, wallets)
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * POST /wallets
 * Add a new wallet
 */
router.post('/', async (req, res) => {
  try {
    const { address, label, chainId, isPrimary } = req.body
    
    if (!address) {
      return badRequest(res, 'Address is required')
    }
    
    const wallet = await walletService.addWallet(req.user.id, {
      address,
      label,
      chainId,
      isPrimary
    })
    
    return created(res, wallet, 'Wallet added')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * GET /wallets/:id
 * Get wallet details
 */
router.get('/:id', async (req, res) => {
  try {
    const wallet = await walletService.getWalletById(req.params.id, req.user.id)
    return success(res, wallet)
  } catch (err) {
    return notFound(res, err.message)
  }
})

/**
 * PUT /wallets/:id
 * Update wallet
 */
router.put('/:id', async (req, res) => {
  try {
    const { label, isPrimary, isActive } = req.body
    
    const wallet = await walletService.updateWallet(
      req.params.id,
      req.user.id,
      { label, isPrimary, isActive }
    )
    
    return success(res, wallet, 'Wallet updated')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * DELETE /wallets/:id
 * Delete wallet
 */
router.delete('/:id', async (req, res) => {
  try {
    await walletService.deleteWallet(req.params.id, req.user.id)
    return success(res, null, 'Wallet deleted')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

/**
 * POST /wallets/:id/primary
 * Set wallet as primary
 */
router.post('/:id/primary', async (req, res) => {
  try {
    const wallet = await walletService.updateWallet(
      req.params.id,
      req.user.id,
      { isPrimary: true }
    )
    return success(res, wallet, 'Wallet set as primary')
  } catch (err) {
    return badRequest(res, err.message)
  }
})

export default router
