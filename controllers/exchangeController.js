const Exchange = require("../models/Exchange");
const axios = require("axios");
const cacheService = require("../services/cacheService");

// Cache keys
const CACHE_KEYS = {
  SUPPORTED_CURRENCIES: "exchange:currencies:supporting",
  ALL_EXCHANGES: "exchange:all",
  EXCHANGE_RATE: (base, target, type) =>
    `exchange:rate:${base}:${target}:${type}`,
  LIVE_RATES: (base) => `exchange:live:${base}`,
  COUNTRY_DATA: "exchange:countries",
};

// Cache TTLs (in seconds)
const CACHE_TTL = {
  SUPPORTED_CURRENCIES: 86400, // 24 hours (currencies don't change often)
  ALL_EXCHANGES: 3600, // 1 hour
  EXCHANGE_RATE: 300, // 5 minutes
  LIVE_RATES: 3600, // 1 hour
  COUNTRY_DATA: 604800, // 7 days
};

// API timeout
const API_TIMEOUT = 10000; // 10 seconds

// Primary currency mappings (static for faster lookup)
const PRIMARY_CURRENCY_MAPPINGS = {
  USD: "USA",
  EUR: "EU",
  GBP: "GBR",
  JPY: "JPN",
  AUD: "AUS",
  CAD: "CAN",
  CHF: "CHE",
  CNY: "CHN",
  INR: "IND",
  BRL: "BRA",
  RUB: "RUS",
};

// Helper to fetch live exchange rates with caching
const fetchLiveRatesCached = async (base = "USD") => {
  const cacheKey = CACHE_KEYS.LIVE_RATES(base);

  // Try cache first
  const cached = await cacheService.get(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const response = await axios.get(
      `https://api.exchangerate-api.com/v4/latest/${base}`,
      {
        timeout: API_TIMEOUT,
      },
    );
    const rates = response.data.rates;

    // Cache for 1 hour
    await cacheService.set(cacheKey, rates, CACHE_TTL.LIVE_RATES);
    return rates;
  } catch (error) {
    console.error("Error fetching exchange rates:", error);
    throw new Error("Unable to fetch current exchange rates");
  }
};

// Helper to fetch country data with caching
const fetchCountryDataCached = async () => {
  const cacheKey = CACHE_KEYS.COUNTRY_DATA;

  // Try cache first
  const cached = await cacheService.get(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const response = await axios.get(
      "https://restcountries.com/v3.1/all?fields=name,currencies,flags,cca3",
      { timeout: API_TIMEOUT },
    );
    const data = response.data;

    // Cache for 7 days
    await cacheService.set(cacheKey, data, CACHE_TTL.COUNTRY_DATA);
    return data;
  } catch (error) {
    console.error("Error fetching country data:", error);
    throw new Error("Unable to fetch country data");
  }
};

// Helper function to determine primary country for a currency (optimized)
function isPrimaryCurrencyCountry(country, currencyCode) {
  if (currencyCode === "EUR" && country.name.common === "European Union") {
    return true;
  }
  return PRIMARY_CURRENCY_MAPPINGS[currencyCode] === country.cca3;
}
// Get all supported currencies with flags
exports.getSupportedCurrencies = async (req, res, next) => {
  try {
    const cacheKey = CACHE_KEYS.SUPPORTED_CURRENCIES;

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    // Fetch rates and countries in parallel
    const [rates, countries] = await Promise.all([
      fetchLiveRatesCached(),
      fetchCountryDataCached(),
    ]);

    const currencyMap = {};

    // Map currencies to countries for flags
    for (const country of countries) {
      if (country.currencies) {
        for (const currencyCode of Object.keys(country.currencies)) {
          if (
            !currencyMap[currencyCode] ||
            isPrimaryCurrencyCountry(country, currencyCode)
          ) {
            currencyMap[currencyCode] = {
              code: currencyCode,
              name: country.currencies[currencyCode].name || currencyCode,
              symbol: country.currencies[currencyCode].symbol || "",
              country: country.name.common,
              flag: country.flags.svg || country.flags.png,
            };
          }
        }
      }
    }

    // Special case for EUR
    if (currencyMap["EUR"]) {
      currencyMap["EUR"].flag = "https://flagcdn.com/eu.svg";
      currencyMap["EUR"].country = "European Union";
    }

    // Add exchange rates
    for (const code of Object.keys(rates)) {
      if (currencyMap[code]) {
        currencyMap[code].rate = rates[code];
      }
    }

    const result = Object.values(currencyMap);

    // Cache the result
    await cacheService.set(cacheKey, result, CACHE_TTL.SUPPORTED_CURRENCIES);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
// Get all exchanges
exports.getAllExchanges = async (req, res, next) => {
  try {
    const cacheKey = CACHE_KEYS.ALL_EXCHANGES;

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const exchanges = await Exchange.find()
      .sort({ baseCurrency: 1, targetCurrency: 1 })
      .lean();

    await cacheService.set(cacheKey, exchanges, CACHE_TTL.ALL_EXCHANGES);

    res.json({
      success: true,
      data: exchanges,
    });
  } catch (error) {
    next(error);
  }
};
// Get exchange rate
exports.getExchangeRate = async (req, res, next) => {
  try {
    const { baseCurrency, targetCurrency, type } = req.params;
    const exchangeType = type || "deposit";

    const cacheKey = CACHE_KEYS.EXCHANGE_RATE(
      baseCurrency,
      targetCurrency,
      exchangeType,
    );

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    // Check for custom exchange rate first
    let exchange = await Exchange.findOne({
      baseCurrency,
      targetCurrency,
      type: exchangeType,
    }).lean();

    let result;

    if (!exchange) {
      // If no custom rate found, get live rate
      const rates = await fetchLiveRatesCached(baseCurrency);
      const rate = rates[targetCurrency];

      if (!rate) {
        return res.status(404).json({
          success: false,
          message: `Exchange rate for ${baseCurrency} to ${targetCurrency} not found`,
        });
      }

      result = {
        baseCurrency,
        targetCurrency,
        rate,
        isCustomRate: false,
        type: exchangeType,
      };
    } else {
      result = exchange;
    }

    // Cache the result
    await cacheService.set(cacheKey, result, CACHE_TTL.EXCHANGE_RATE);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
// Create exchange rate
exports.createExchange = async (req, res, next) => {
  try {
    const { baseCurrency, targetCurrency, rate, type } = req.body;

    // Validate inputs
    if (!baseCurrency || !targetCurrency || !rate || !type) {
      return res.status(400).json({
        success: false,
        message: "Base currency, target currency, rate, and type are required",
      });
    }

    // Check if exchange already exists
    const existingExchange = await Exchange.findOne({
      baseCurrency,
      targetCurrency,
      type,
    });

    if (existingExchange) {
      return res.status(400).json({
        success: false,
        message: "Exchange rate already exists. Use update endpoint.",
      });
    }

    // Create new exchange
    const exchange = await Exchange.create({
      baseCurrency: baseCurrency.toUpperCase(),
      targetCurrency: targetCurrency.toUpperCase(),
      rate,
      type,
      isCustomRate: true,
    });

    // Invalidate caches
    await invalidateExchangeCaches(baseCurrency, targetCurrency, type);

    res.status(201).json({
      success: true,
      data: exchange,
    });
  } catch (error) {
    next(error);
  }
};
// Update exchange rate
exports.updateExchange = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rate, type } = req.body;

    if (!rate) {
      return res.status(400).json({
        success: false,
        message: "Rate is required",
      });
    }

    // Get the exchange before update to know cache keys to invalidate
    const oldExchange = await Exchange.findById(id).lean();

    if (!oldExchange) {
      return res.status(404).json({
        success: false,
        message: "Exchange not found",
      });
    }

    const exchange = await Exchange.findByIdAndUpdate(
      id,
      {
        rate,
        type: type || oldExchange.type,
        isCustomRate: true,
        lastUpdated: Date.now(),
      },
      { new: true },
    );

    // Invalidate caches
    await invalidateExchangeCaches(
      oldExchange.baseCurrency,
      oldExchange.targetCurrency,
      oldExchange.type,
    );

    res.json({
      success: true,
      data: exchange,
    });
  } catch (error) {
    next(error);
  }
};
// Delete exchange
exports.deleteExchange = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Get the exchange before deletion to know cache keys to invalidate
    const exchange = await Exchange.findById(id).lean();

    if (!exchange) {
      return res.status(404).json({
        success: false,
        message: "Exchange not found",
      });
    }

    await Exchange.findByIdAndDelete(id);

    // Invalidate caches
    await invalidateExchangeCaches(
      exchange.baseCurrency,
      exchange.targetCurrency,
      exchange.type,
    );

    res.json({
      success: true,
      message: "Exchange deleted successfully",
    });
  } catch (error) {
    next(error);
  }
};
// Force refresh of currency data (admin only)
exports.refreshCurrencyCache = async (req, res, next) => {
  try {
    // Clear all currency-related caches
    await Promise.all([
      cacheService.deletePattern(CACHE_KEYS.SUPPORTED_CURRENCIES),
      cacheService.deletePattern(CACHE_KEYS.COUNTRY_DATA),
      cacheService.deletePattern(CACHE_KEYS.LIVE_RATES("*")),
    ]);

    // Fetch fresh data
    const [rates, countries] = await Promise.all([
      fetchLiveRatesCached("USD"),
      fetchCountryDataCached(),
    ]);

    res.json({
      success: true,
      message: "Currency cache refreshed successfully",
    });
  } catch (error) {
    next(error);
  }
};
// Invalidate exchange-related caches
const invalidateExchangeCaches = async (baseCurrency, targetCurrency, type) => {
  const promises = [
    cacheService.deletePattern(CACHE_KEYS.ALL_EXCHANGES),
    cacheService.deletePattern(
      CACHE_KEYS.EXCHANGE_RATE(baseCurrency, targetCurrency, type),
    ),
  ];

  await Promise.all(promises);
  console.log(
    `🗑️ Exchange caches invalidated for ${baseCurrency}/${targetCurrency}`,
  );
};

// Export cache invalidation function
exports.invalidateExchangeCaches = invalidateExchangeCaches;
