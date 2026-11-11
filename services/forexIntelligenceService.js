const axios = require("axios");
const cacheService = require("./cacheService");

const FRANKFURTER_BASE_URL = "https://api.frankfurter.dev/v1";
const COINGECKO_BASE_URL = "https://api.coingecko.com/api/v3";
const GNEWS_BASE_URL = "https://gnews.io/api/v4";
const MARKET_CACHE_PREFIX = "market:intelligence";
const MARKET_BACKUP_CACHE_PREFIX = "market:intelligence:backup";
const MARKET_CACHE_TTL_SECONDS = {
  forex: 2 * 60 * 60,
  crypto: 20 * 60,
};
const NEWS_CACHE_TTL_SECONDS = 24 * 60 * 60;
const BACKUP_CACHE_TTL_SECONDS = {
  forex: 3 * 24 * 60 * 60,
  crypto: 24 * 60 * 60,
};
const DEFAULT_INCLUDE_NEWS = false;
const DEFAULT_NEWS_LIMIT = 3;
const MARKET_FETCH_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.MARKET_FETCH_CONCURRENCY || "4", 10) || 4,
);

const FOREX_PAIRS = [
  {
    symbol: "XAUUSD",
    label: "XAU / USD",
    baseCurrency: "XAU",
    quoteCurrency: "USD",
    baseName: "Gold",
    quoteName: "US Dollar",
  },
  {
    symbol: "EURUSD",
    label: "EUR / USD",
    baseCurrency: "EUR",
    quoteCurrency: "USD",
    baseName: "Euro",
    quoteName: "US Dollar",
  },
  {
    symbol: "GBPUSD",
    label: "GBP / USD",
    baseCurrency: "GBP",
    quoteCurrency: "USD",
    baseName: "British Pound",
    quoteName: "US Dollar",
  },
  {
    symbol: "USDJPY",
    label: "USD / JPY",
    baseCurrency: "USD",
    quoteCurrency: "JPY",
    baseName: "US Dollar",
    quoteName: "Japanese Yen",
  },
  {
    symbol: "AUDUSD",
    label: "AUD / USD",
    baseCurrency: "AUD",
    quoteCurrency: "USD",
    baseName: "Australian Dollar",
    quoteName: "US Dollar",
  },
  {
    symbol: "NZDUSD",
    label: "NZD / USD",
    baseCurrency: "NZD",
    quoteCurrency: "USD",
    baseName: "New Zealand Dollar",
    quoteName: "US Dollar",
  },
  {
    symbol: "USDCAD",
    label: "USD / CAD",
    baseCurrency: "USD",
    quoteCurrency: "CAD",
    baseName: "US Dollar",
    quoteName: "Canadian Dollar",
  },
  {
    symbol: "USDCHF",
    label: "USD / CHF",
    baseCurrency: "USD",
    quoteCurrency: "CHF",
    baseName: "US Dollar",
    quoteName: "Swiss Franc",
  },
  {
    symbol: "EURGBP",
    label: "EUR / GBP",
    baseCurrency: "EUR",
    quoteCurrency: "GBP",
    baseName: "Euro",
    quoteName: "British Pound",
  },
  {
    symbol: "EURJPY",
    label: "EUR / JPY",
    baseCurrency: "EUR",
    quoteCurrency: "JPY",
    baseName: "Euro",
    quoteName: "Japanese Yen",
  },
  {
    symbol: "GBPJPY",
    label: "GBP / JPY",
    baseCurrency: "GBP",
    quoteCurrency: "JPY",
    baseName: "British Pound",
    quoteName: "Japanese Yen",
  },
  {
    symbol: "EURAUD",
    label: "EUR / AUD",
    baseCurrency: "EUR",
    quoteCurrency: "AUD",
    baseName: "Euro",
    quoteName: "Australian Dollar",
  },
  {
    symbol: "AUDJPY",
    label: "AUD / JPY",
    baseCurrency: "AUD",
    quoteCurrency: "JPY",
    baseName: "Australian Dollar",
    quoteName: "Japanese Yen",
  },
];

const CRYPTO_ASSETS = [
  {
    symbol: "BTCUSD",
    label: "BTC / USD",
    baseCurrency: "BTC",
    quoteCurrency: "USD",
    baseName: "Bitcoin",
    quoteName: "US Dollar",
    coinGeckoId: "bitcoin",
  },
  {
    symbol: "ETHUSD",
    label: "ETH / USD",
    baseCurrency: "ETH",
    quoteCurrency: "USD",
    baseName: "Ethereum",
    quoteName: "US Dollar",
    coinGeckoId: "ethereum",
  },
  {
    symbol: "SOLUSD",
    label: "SOL / USD",
    baseCurrency: "SOL",
    quoteCurrency: "USD",
    baseName: "Solana",
    quoteName: "US Dollar",
    coinGeckoId: "solana",
  },
  {
    symbol: "XRPUSD",
    label: "XRP / USD",
    baseCurrency: "XRP",
    quoteCurrency: "USD",
    baseName: "XRP",
    quoteName: "US Dollar",
    coinGeckoId: "ripple",
  },
  {
    symbol: "BNBUSD",
    label: "BNB / USD",
    baseCurrency: "BNB",
    quoteCurrency: "USD",
    baseName: "BNB",
    quoteName: "US Dollar",
    coinGeckoId: "binancecoin",
  },
  {
    symbol: "ADAUSD",
    label: "ADA / USD",
    baseCurrency: "ADA",
    quoteCurrency: "USD",
    baseName: "Cardano",
    quoteName: "US Dollar",
    coinGeckoId: "cardano",
  },
];

const MARKET_CONFIG = {
  forex: {
    assetType: "forex",
    title: "Currency market outlook",
    marketDataLabel: "Frankfurter FX rates with fxapi.app metals fallback",
    defaultSymbols: FOREX_PAIRS,
    marketCacheTtlSeconds: MARKET_CACHE_TTL_SECONDS.forex,
  },
  crypto: {
    assetType: "crypto",
    title: "Crypto market outlook",
    marketDataLabel: "CoinGecko demo crypto market data",
    defaultSymbols: CRYPTO_ASSETS,
    marketCacheTtlSeconds: MARKET_CACHE_TTL_SECONDS.crypto,
  },
};

class ServiceError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name = "ServiceError";
    this.statusCode = statusCode;
  }
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const roundTo = (value, digits = 4) => {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return 0;
  }

  return Number(amount.toFixed(digits));
};

const average = (values) => {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const getAssetTypeConfig = (assetType = "forex") => {
  const normalizedAssetType = String(assetType || "forex").toLowerCase();
  const config = MARKET_CONFIG[normalizedAssetType];

  if (!config) {
    throw new ServiceError(
      `Unsupported asset type: ${assetType}. Supported values: ${Object.keys(MARKET_CONFIG).join(", ")}`,
      400,
    );
  }

  return config;
};

const parseSymbolList = (symbols, supportedAssets, assetType) => {
  if (!symbols) {
    return supportedAssets;
  }

  const requestedSymbols = String(symbols)
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);

  const selectedAssets = supportedAssets.filter((asset) =>
    requestedSymbols.includes(asset.symbol),
  );

  if (selectedAssets.length === 0) {
    throw new ServiceError(
      `No supported ${assetType} symbols were requested. Supported symbols: ${supportedAssets.map((asset) => asset.symbol).join(", ")}`,
      400,
    );
  }

  return selectedAssets;
};

const buildCacheKey = ({ assetType, symbols, newsLimit, includeNews }) =>
  cacheService.generateKey(MARKET_CACHE_PREFIX, {
    assetType,
    symbols: symbols.map((asset) => asset.symbol),
    newsLimit,
    includeNews,
  });

const buildBackupCacheKey = ({ assetType, symbols, newsLimit, includeNews }) =>
  cacheService.generateKey(MARKET_BACKUP_CACHE_PREFIX, {
    assetType,
    symbols: symbols.map((asset) => asset.symbol),
    newsLimit,
    includeNews,
  });

const buildNewsCacheKey = ({ assetType, symbol, newsLimit }) =>
  cacheService.generateKey(`${MARKET_CACHE_PREFIX}:news`, {
    assetType,
    symbol,
    newsLimit,
  });

const runWithConcurrency = async (items, limit, worker) => {
  const results = new Array(items.length);
  let nextIndex = 0;

  const runner = async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) {
        return;
      }

      try {
        results[currentIndex] = {
          status: "fulfilled",
          value: await worker(items[currentIndex], currentIndex),
        };
      } catch (error) {
        results[currentIndex] = {
          status: "rejected",
          reason: error,
        };
      }
    }
  };

  const concurrency = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: concurrency }, () => runner()));
  return results;
};

const calculateMovingAverage = (values, period) => {
  if (values.length === 0) {
    return 0;
  }

  const window = values.slice(-period);
  return average(window);
};

const calculateVolatility = (closes, period = 10) => {
  const values = closes.slice(-(period + 1));
  if (values.length < 2) {
    return 0;
  }

  const returns = [];
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous > 0) {
      returns.push(Math.abs((current - previous) / previous));
    }
  }

  return average(returns) * 100;
};

const buildRecommendation = (score, confidence) => {
  if (score >= 0.45 && confidence >= 70) {
    return "favorable";
  }

  if (score <= -0.45 && confidence >= 70) {
    return "avoid";
  }

  return "watch";
};

const buildDirection = (score) => {
  if (score >= 0.16) {
    return "bullish";
  }

  if (score <= -0.16) {
    return "bearish";
  }

  return "neutral";
};

const buildReasons = ({
  trend5d,
  trend20d,
  momentumVsSma,
  volatility,
  hasNews,
}) => {
  const reasons = [
    `${trend5d >= 0 ? "+" : ""}${trend5d.toFixed(2)}% 5-day trend`,
    `${trend20d >= 0 ? "+" : ""}${trend20d.toFixed(2)}% 20-day trend`,
    `${momentumVsSma >= 0 ? "+" : ""}${momentumVsSma.toFixed(2)}% vs recent average`,
    `${volatility.toFixed(2)}% average daily movement`,
    "Based on recent market data",
  ];

  if (hasNews) {
    reasons.push("Headline sentiment was added from a free news feed");
  }

  return reasons;
};

const getPriceDigits = (assetType, symbol, price) => {
  if (assetType === "forex") {
    if (
      symbol.includes("XAU") ||
      symbol.includes("XAG") ||
      symbol.includes("XPT") ||
      symbol.includes("XPD")
    ) {
      return 2;
    }

    return symbol.includes("JPY") ? 3 : 5;
  }

  if (price >= 1000) {
    return 2;
  }

  if (price >= 1) {
    return 3;
  }

  return 5;
};

const normalizeNewsSentimentLabel = (sentimentScore) => {
  if (sentimentScore >= 0.2) {
    return "Positive";
  }

  if (sentimentScore <= -0.2) {
    return "Negative";
  }

  return "Neutral";
};

const isMetalSymbol = (symbol = "") =>
  ["XAU", "XAG", "XPT", "XPD"].some((code) => symbol.includes(code));

const scoreArticles = (articles = []) => {
  if (!articles.length) {
    return {
      score: 0,
      coverage: 0,
      headlines: [],
    };
  }

  const headlines = articles.slice(0, 5).map((article) => {
    const title = article.title || "Untitled";
    const description = article.description || "";
    const text = `${title} ${description}`.toLowerCase();

    let sentimentScore = 0;
    const positiveWords = [
      "surge",
      "gain",
      "rise",
      "bullish",
      "record",
      "strong",
      "approval",
      "growth",
      "rally",
    ];
    const negativeWords = [
      "drop",
      "fall",
      "bearish",
      "weak",
      "selloff",
      "loss",
      "crash",
      "risk",
      "concern",
    ];

    positiveWords.forEach((word) => {
      if (text.includes(word)) {
        sentimentScore += 0.18;
      }
    });

    negativeWords.forEach((word) => {
      if (text.includes(word)) {
        sentimentScore -= 0.18;
      }
    });

    const normalizedScore = clamp(roundTo(sentimentScore, 2), -1, 1);

    return {
      title,
      source: article.source?.name || "News source",
      url: article.url || "",
      timePublished: article.publishedAt || new Date().toISOString(),
      sentimentLabel: normalizeNewsSentimentLabel(normalizedScore),
      sentimentScore: normalizedScore,
    };
  });

  return {
    score: roundTo(average(headlines.map((headline) => headline.sentimentScore)), 2),
    coverage: headlines.length,
    headlines,
  };
};

const fetchOptionalNews = async ({ assetType, asset, newsLimit }) => {
  const apiKey = process.env.GNEWS_API_KEY;
  if (!apiKey) {
    return {
      score: 0,
      coverage: 0,
      headlines: [],
      providerLabel: "Not included",
    };
  }

  const cacheKey = buildNewsCacheKey({
    assetType,
    symbol: asset.symbol,
    newsLimit,
  });

  const cached = await cacheService.get(cacheKey);
  if (cached) {
    return cached;
  }

  const query =
    assetType === "crypto"
      ? `${asset.baseName} crypto OR ${asset.baseCurrency} crypto`
      : `${asset.baseName} ${asset.quoteName} forex`;

  try {
    const response = await axios.get(`${GNEWS_BASE_URL}/search`, {
      params: {
        q: query,
        lang: "en",
        max: Math.min(Math.max(newsLimit, 3), 10),
        apikey: apiKey,
      },
      timeout: 20000,
    });

    const scored = scoreArticles(Array.isArray(response.data?.articles) ? response.data.articles : []);
    const payload = {
      ...scored,
      providerLabel: "GNews free delayed headlines",
    };

    await cacheService.set(cacheKey, payload, NEWS_CACHE_TTL_SECONDS);
    return payload;
  } catch (error) {
    return {
      score: 0,
      coverage: 0,
      headlines: [],
      providerLabel: "GNews unavailable",
    };
  }
};

const isRateLimitError = (error) => {
  const status = error?.response?.status;
  const message = String(error?.message || "").toLowerCase();

  return (
    status === 429 ||
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("quota")
  );
};

const buildAssetForecast = (asset, candles, assetType, newsSnapshot) => {
  if (!Array.isArray(candles) || candles.length < 20) {
    return null;
  }

  const closes = candles.map((item) => item.close);
  const latestCandle = candles[candles.length - 1];
  const latestClose = latestCandle.close;
  const prev5 = candles[Math.max(candles.length - 6, 0)]?.close || latestClose;
  const prev20 =
    candles[Math.max(candles.length - 21, 0)]?.close || latestClose;
  const sma5 = calculateMovingAverage(closes, 5);
  const sma20 = calculateMovingAverage(closes, 20);
  const volatility = calculateVolatility(closes, 10);
  const recentCandles = candles.slice(-10);
  const support = Math.min(...recentCandles.map((item) => item.low));
  const resistance = Math.max(...recentCandles.map((item) => item.high));
  const trend5d = prev5 ? ((latestClose - prev5) / prev5) * 100 : 0;
  const trend20d = prev20 ? ((latestClose - prev20) / prev20) * 100 : 0;
  const momentumVsSma = sma5 ? ((latestClose - sma5) / sma5) * 100 : 0;
  const newsScore = newsSnapshot?.score || 0;
  const score =
    trend5d * 0.28 +
    trend20d * 0.34 +
    momentumVsSma * 0.18 +
    Math.min(volatility * 0.55, 2.2) +
    newsScore * 1.4;
  const normalizedScore = roundTo(score / 10, 4);
  const confidence = clamp(
    Math.round(
      48 +
        Math.abs(trend20d) * 8 +
        Math.abs(trend5d) * 10 +
        Math.min(volatility * 6, 12) +
        Math.abs(newsScore) * 12,
    ),
    35,
    95,
  );
  const direction = buildDirection(normalizedScore);
  const recommendation = buildRecommendation(normalizedScore, confidence);
  const digits = getPriceDigits(assetType, asset.symbol, latestClose);
  const projectedMovePct = clamp(
    Math.abs(trend5d) * 0.7 + volatility * 0.8 + Math.abs(newsScore) * 0.6,
    0.15,
    assetType === "crypto" ? 8 : 3.5,
  );

  return {
    assetType,
    symbol: asset.symbol,
    label: asset.label,
    baseCurrency: asset.baseCurrency,
    quoteCurrency: asset.quoteCurrency,
    currentPrice: roundTo(latestClose, digits),
    support: roundTo(support, digits),
    resistance: roundTo(resistance, digits),
    shortTrendPct: roundTo(trend5d, 2),
    mediumTrendPct: roundTo(trend20d, 2),
    momentumVsSmaPct: roundTo(momentumVsSma, 2),
    volatilityPct: roundTo(volatility, 2),
    projectedMovePct: roundTo(projectedMovePct, 2),
    newsSentimentScore: roundTo(newsScore, 2),
    newsCoverage: newsSnapshot?.coverage || 0,
    confidence,
    direction,
    recommendation,
    reasons: buildReasons({
      trend5d,
      trend20d,
      momentumVsSma,
      volatility,
      hasNews: Boolean(newsSnapshot?.coverage),
    }),
    recentHeadlines: newsSnapshot?.headlines || [],
    lastUpdated: latestCandle.date,
    dataPoints: candles.length,
  };
};

const fetchFxDaily = async (asset) => {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 45);

  const from = startDate.toISOString().slice(0, 10);
  const to = endDate.toISOString().slice(0, 10);

  const fetchFxApiHistory = async () => {
    const response = await axios.get(
      `https://fxapi.app/api/history/${asset.baseCurrency}/${asset.quoteCurrency}.json`,
      {
        params: {
          from,
          to,
        },
        timeout: 20000,
      },
    );

    const history = Array.isArray(response.data?.rates) ? response.data.rates : [];
    if (history.length === 0) {
      throw new ServiceError(
        `Invalid response received for ${asset.symbol} from fxapi.app.`,
        502,
      );
    }

    return history
      .map((entry) => {
        const close = Number(entry?.rate);

        return {
          date: entry?.date,
          open: close,
          high: close,
          low: close,
          close,
        };
      })
      .filter((item) => item.date && Number.isFinite(item.close))
      .sort((left, right) => new Date(left.date) - new Date(right.date));
  };

  if (isMetalSymbol(asset.symbol)) {
    return fetchFxApiHistory();
  }

  try {
    const response = await axios.get(`${FRANKFURTER_BASE_URL}/${from}..${to}`, {
      params: {
        base: asset.baseCurrency,
        symbols: asset.quoteCurrency,
      },
      timeout: 20000,
    });

    const payload = response.data;

    if (!payload || typeof payload !== "object" || !payload.rates) {
      throw new ServiceError(
        `Invalid response received for ${asset.symbol} from Frankfurter.`,
        502,
      );
    }

    return Object.entries(payload.rates)
      .map(([date, rates]) => {
        const close = Number(rates[asset.quoteCurrency]);
        return {
          date,
          open: close,
          high: close,
          low: close,
          close,
        };
      })
      .filter((item) => Number.isFinite(item.close))
      .sort((left, right) => new Date(left.date) - new Date(right.date));
  } catch (error) {
    if (error?.response?.status === 404) {
      return fetchFxApiHistory();
    }

    throw error;
  }
};

const fetchCryptoDaily = async (asset) => {
  const apiKey =
    process.env.COINGECKO_DEMO_API_KEY || process.env.COINGECKO_API_KEY;
  if (!apiKey) {
    throw new ServiceError(
      "CoinGecko API key is missing. Add COINGECKO_DEMO_API_KEY in backend-dev/.env and restart the backend server.",
      500,
    );
  }

  const response = await axios.get(
    `${COINGECKO_BASE_URL}/coins/${asset.coinGeckoId}/market_chart`,
    {
      params: {
        vs_currency: "usd",
        days: 45,
        interval: "daily",
      },
      headers: {
        "x-cg-demo-api-key": apiKey,
      },
      timeout: 20000,
    },
  );

  const prices = Array.isArray(response.data?.prices) ? response.data.prices : [];
  if (prices.length === 0) {
    throw new ServiceError(
      `Invalid response received for ${asset.symbol} from CoinGecko.`,
      502,
    );
  }

  return prices
    .map(([timestamp, close]) => ({
      date: new Date(timestamp).toISOString().slice(0, 10),
      open: Number(close),
      high: Number(close),
      low: Number(close),
      close: Number(close),
    }))
    .filter((item) => Number.isFinite(item.close))
    .sort((left, right) => new Date(left.date) - new Date(right.date));
};

const buildMarketSummary = (forecasts) => {
  const bullish = forecasts.filter(
    (forecast) => forecast.direction === "bullish",
  ).length;
  const bearish = forecasts.filter(
    (forecast) => forecast.direction === "bearish",
  ).length;
  const favorable = forecasts.filter(
    (forecast) => forecast.recommendation === "favorable",
  );
  const avoid = forecasts.filter(
    (forecast) => forecast.recommendation === "avoid",
  );
  const averageConfidence = roundTo(
    average(forecasts.map((forecast) => forecast.confidence)),
    0,
  );
  const strongestOpportunity =
    favorable.sort((left, right) => right.confidence - left.confidence)[0] ||
    forecasts
      .filter((forecast) => forecast.direction !== "neutral")
      .sort((left, right) => right.confidence - left.confidence)[0] ||
    forecasts[0] ||
    null;
  const riskOffAsset =
    avoid.sort((left, right) => right.confidence - left.confidence)[0] || null;

  return {
    pairsAnalyzed: forecasts.length,
    bullishPairs: bullish,
    bearishPairs: bearish,
    favorableSetups: favorable.length,
    avoidSetups: avoid.length,
    averageConfidence,
    strongestOpportunity: strongestOpportunity
      ? {
          symbol: strongestOpportunity.symbol,
          label: strongestOpportunity.label,
          direction: strongestOpportunity.direction,
          recommendation: strongestOpportunity.recommendation,
          confidence: strongestOpportunity.confidence,
        }
      : null,
    highestRiskSetup: riskOffAsset
      ? {
          symbol: riskOffAsset.symbol,
          label: riskOffAsset.label,
          direction: riskOffAsset.direction,
          recommendation: riskOffAsset.recommendation,
          confidence: riskOffAsset.confidence,
        }
      : null,
  };
};

const fetchCandlesByAssetType = async (assetType, asset) => {
  if (assetType === "crypto") {
    return fetchCryptoDaily(asset);
  }

  return fetchFxDaily(asset);
};

const getMarketForecast = async ({
  assetType = "forex",
  symbols,
  newsLimit = DEFAULT_NEWS_LIMIT,
  refresh = false,
  includeNews = DEFAULT_INCLUDE_NEWS,
}) => {
  const config = getAssetTypeConfig(assetType);
  const selectedAssets = parseSymbolList(
    symbols,
    config.defaultSymbols,
    config.assetType,
  );
  const cacheKey = buildCacheKey({
    assetType: config.assetType,
    symbols: selectedAssets,
    newsLimit,
    includeNews,
  });
  const backupCacheKey = buildBackupCacheKey({
    assetType: config.assetType,
    symbols: selectedAssets,
    newsLimit,
    includeNews,
  });

  if (!refresh) {
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return {
        ...cached,
        cached: true,
      };
    }
  }

  let assetResults;

  try {
    const settledAssetResults = await runWithConcurrency(
      selectedAssets,
      MARKET_FETCH_CONCURRENCY,
      async (asset) => {
        try {
          const [candles, newsSnapshot] = await Promise.all([
            fetchCandlesByAssetType(config.assetType, asset),
            includeNews
              ? fetchOptionalNews({
                  assetType: config.assetType,
                  asset,
                  newsLimit,
                })
              : Promise.resolve({
                  score: 0,
                  coverage: 0,
                  headlines: [],
                  providerLabel: "Not included",
                }),
          ]);

          return {
            asset,
            candles,
            newsSnapshot,
          };
        } catch (error) {
          error.assetSymbol = asset.symbol;
          throw error;
        }
      },
    );

    const rejectedAssetResults = settledAssetResults.filter(
      (result) => result.status === "rejected",
    );

    if (rejectedAssetResults.length === settledAssetResults.length) {
      throw rejectedAssetResults[0].reason;
    }

    assetResults = settledAssetResults
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value);

    rejectedAssetResults.forEach((result) => {
      console.warn(
        `Skipping ${config.assetType} asset ${result.reason?.assetSymbol || "unknown"} due to upstream market data error:`,
        result.reason?.message || result.reason,
      );
    });
  } catch (error) {
    const backup = await cacheService.get(backupCacheKey);
    if (backup && (isRateLimitError(error) || error instanceof ServiceError)) {
      return {
        ...backup,
        cached: true,
        staleFallback: true,
        staleReason: isRateLimitError(error)
          ? "Free API limit reached. Showing older saved forecast data for a longer period."
          : "Upstream market data provider is temporarily failing. Showing older saved forecast data.",
      };
    }

    throw error;
  }

  const forecasts = assetResults
    .map(({ asset, candles, newsSnapshot }) =>
      buildAssetForecast(asset, candles, config.assetType, newsSnapshot),
    )
    .filter(Boolean)
    .sort((left, right) => right.confidence - left.confidence);

  if (forecasts.length === 0) {
    throw new ServiceError(
      `No ${config.assetType} market data could be built from the configured providers.`,
      502,
    );
  }

  const activeNewsProvider =
    assetResults.find((result) => result.newsSnapshot?.providerLabel)?.newsSnapshot
      ?.providerLabel || "Not included";

  const payload = {
    assetType: config.assetType,
    title: config.title,
    generatedAt: new Date().toISOString(),
    provider: {
      marketData: config.marketDataLabel,
      news: activeNewsProvider,
    },
    summary: buildMarketSummary(forecasts),
    forecasts,
    cachePolicy: {
      marketRefreshSeconds: config.marketCacheTtlSeconds,
      newsRefreshSeconds: NEWS_CACHE_TTL_SECONDS,
      backupRefreshSeconds: BACKUP_CACHE_TTL_SECONDS[config.assetType],
      includeNewsByDefault: DEFAULT_INCLUDE_NEWS,
    },
    disclaimer:
      "This module provides simple market signals from free data sources. It is market research, not personalized investment advice.",
    staleFallback: false,
    staleReason: null,
  };

  await cacheService.set(cacheKey, payload, config.marketCacheTtlSeconds);
  await cacheService.set(
    backupCacheKey,
    payload,
    BACKUP_CACHE_TTL_SECONDS[config.assetType],
  );

  return {
    ...payload,
    cached: false,
  };
};

const getForexForecast = async (options = {}) =>
  getMarketForecast({
    ...options,
    assetType: "forex",
  });

module.exports = {
  FOREX_PAIRS,
  CRYPTO_ASSETS,
  DEFAULT_INCLUDE_NEWS,
  DEFAULT_NEWS_LIMIT,
  ServiceError,
  getForexForecast,
  getMarketForecast,
};
