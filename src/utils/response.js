/**
 * ============================================================================
 * SERAPH SERVER - Response Helpers
 * ============================================================================
 */

/**
 * Success response
 */
export function success(res, data = null, message = 'Success', statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
    timestamp: new Date().toISOString()
  })
}

/**
 * Created response (201)
 */
export function created(res, data, message = 'Created successfully') {
  return success(res, data, message, 201)
}

/**
 * Error response
 */
export function error(res, message = 'An error occurred', statusCode = 500, details = null) {
  return res.status(statusCode).json({
    success: false,
    message,
    error: details,
    timestamp: new Date().toISOString()
  })
}

/**
 * Bad request (400)
 */
export function badRequest(res, message = 'Bad request', details = null) {
  return error(res, message, 400, details)
}

/**
 * Unauthorized (401)
 */
export function unauthorized(res, message = 'Unauthorized') {
  return error(res, message, 401)
}

/**
 * Forbidden (403)
 */
export function forbidden(res, message = 'Forbidden') {
  return error(res, message, 403)
}

/**
 * Not found (404)
 */
export function notFound(res, message = 'Not found') {
  return error(res, message, 404)
}

/**
 * Conflict (409)
 */
export function conflict(res, message = 'Conflict') {
  return error(res, message, 409)
}

/**
 * Paginated response
 */
export function paginated(res, data, pagination, message = 'Success') {
  return res.status(200).json({
    success: true,
    message,
    data,
    pagination: {
      page: pagination.page,
      limit: pagination.limit,
      total: pagination.total,
      totalPages: Math.ceil(pagination.total / pagination.limit),
      hasMore: pagination.page * pagination.limit < pagination.total
    },
    timestamp: new Date().toISOString()
  })
}

export default {
  success,
  created,
  error,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  paginated
}
