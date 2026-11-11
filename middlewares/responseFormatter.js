/**
 * Standard API Response Formatter
 * Ensures all API responses follow the same structure
 */

// Success response formatter
const successResponse = (res, data, message = "Success", statusCode = 200) => {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
    timestamp: new Date().toISOString(),
  });
};

// Error response formatter
const errorResponse = (
  res,
  message = "Internal Server Error",
  statusCode = 500,
  errorCode = null,
) => {
  return res.status(statusCode).json({
    success: false,
    message,
    errorCode,
    timestamp: new Date().toISOString(),
  });
};

// Paginated response formatter
const paginatedResponse = (res, data, pagination, message = "Success") => {
  return res.status(200).json({
    success: true,
    message,
    data,
    pagination: {
      page: pagination.page,
      limit: pagination.limit,
      total: pagination.total,
      pages: pagination.pages,
      hasNext: pagination.page < pagination.pages,
      hasPrev: pagination.page > 1,
    },
    timestamp: new Date().toISOString(),
  });
};

// Middleware to attach formatters to res object
const responseFormatter = (req, res, next) => {
  res.success = (data, message, statusCode) =>
    successResponse(res, data, message, statusCode);
  res.error = (message, statusCode, errorCode) =>
    errorResponse(res, message, statusCode, errorCode);
  res.paginated = (data, pagination, message) =>
    paginatedResponse(res, data, pagination, message);
  next();
};

module.exports = {
  successResponse,
  errorResponse,
  paginatedResponse,
  responseFormatter,
};
