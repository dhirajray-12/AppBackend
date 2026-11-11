const paginate = (model, options = {}) => {
  return async (req, res, next) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;

    // Build query with filters
    let query = {};

    // Apply filters from query params
    if (options.filterFields) {
      for (const field of options.filterFields) {
        if (req.query[field]) {
          query[field] = req.query[field];
        }
      }
    }

    // Apply search
    if (options.searchFields && req.query.search) {
      const searchRegex = new RegExp(req.query.search, "i");
      query.$or = options.searchFields.map((field) => ({
        [field]: searchRegex,
      }));
    }

    // Execute count query
    const total = await model.countDocuments(query);

    // Build pagination result
    const pagination = {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      hasNext: endIndex < total,
      hasPrev: startIndex > 0,
    };

    // Attach pagination info to request
    req.pagination = pagination;
    req.queryOptions = {
      skip: startIndex,
      limit,
      sort: options.defaultSort || { createdAt: -1 },
    };

    next();
  };
};

// Response wrapper for paginated results
const paginatedResponse = (data, pagination, message = "Success") => {
  return {
    success: true,
    message,
    data,
    pagination: {
      currentPage: pagination.page,
      totalPages: pagination.pages,
      totalItems: pagination.total,
      itemsPerPage: pagination.limit,
      hasNextPage: pagination.hasNext,
      hasPrevPage: pagination.hasPrev,
    },
  };
};

module.exports = {
  paginate,
  paginatedResponse,
};
