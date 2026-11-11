const mongoose = require("mongoose");
const User = require("../../models/User");
const Profile = require("../../models/client/Profile");
const Account = require("../../models/client/Account");
const Deposit = require("../../models/Deposit");
const Withdrawal = require("../../models/withdrawal");
const Transfer = require("../../models/client/Transfer");
const Notification = require("../../models/Notification");
const Ticket = require("../../models/Ticket");
const {
  CRYPTO_ASSETS,
  FOREX_PAIRS,
  getMarketForecast,
} = require("../../services/forexIntelligenceService");
const {
  generateAssistantIntent,
  isOpenAIConfigured,
} = require("../../services/openaiAssistantService");
const {
  analyzeAssistantSentiment,
  prefixReplyWithSentiment,
} = require("../../services/assistantSentimentService");
const cacheService = require("../../services/cacheService");
const { AppError } = require("../../middlewares/errorHandler");

const ASSISTANT_CONTEXT_TTL_SECONDS = 30;

const getAssistantContextCacheKey = (userId) =>
  `assistant:context:${userId}`;

const PAGE_ROUTES = {
  dashboard: "/client/dashboard",
  home: "/client/dashboard",
  "open account": "/client/open-account",
  "new account": "/client/open-account",
  "create account": "/client/open-account",
  "create trading account": "/client/open-account",
  "account list": "/client/account-list",
  accounts: "/client/account-list",
  "my accounts": "/client/account-list",
  deposit: "/client/deposit",
  deposits: "/client/deposit",
  withdrawal: "/client/withdrawal",
  withdraw: "/client/withdrawal",
  withdrawals: "/client/withdrawal",
  transfer: "/client/transfer",
  "transaction history": "/client/transfer-history",
  transactions: "/client/transfer-history",
  history: "/client/transfer-history",
  support: "/client/support",
  tickets: "/client/support",
  profile: "/client/profile",
  "my profile": "/client/profile",
  platforms: "/client/platforms",
  "live trade": "/client/live-chart",
  "live chart": "/client/live-chart",
  "forex chart": "/client/live-chart",
  "trading chart": "/client/live-chart",
  chart: "/client/live-chart",
  "trading contest": "/client/trading-contest",
  contest: "/client/trading-contest",
  refer: "/client/refer",
  "refer a friend": "/client/refer",
  "partner dashboard": "/client/partner/dashboard",
  "ib dashboard": "/client/partner/dashboard",
  "create partner account": "/client/partner/create",
  "partner account": "/client/partner/create",
  "partner commission": "/client/partner/commission",
  "partner withdrawal": "/client/partner/withdrawal",
  "copy trading master": "/client/copy/master",
  "copy master": "/client/copy/master",
  "copy trading terms": "/client/copy/terms",
  "copy trading copier": "/client/copy/copier",
  "copy trading rating": "/client/copy/rating",
};

// Canonical navigation targets the AI is allowed to choose from (route -> label).
const ASSISTANT_ROUTE_CATALOG = [
  { route: "/client/dashboard", label: "dashboard" },
  { route: "/client/open-account", label: "open account" },
  { route: "/client/account-list", label: "account list" },
  { route: "/client/deposit", label: "deposit" },
  { route: "/client/withdrawal", label: "withdrawal" },
  { route: "/client/transfer", label: "transfer" },
  { route: "/client/transfer-history", label: "transaction history" },
  { route: "/client/support", label: "support" },
  { route: "/client/profile", label: "profile" },
  { route: "/client/platforms", label: "platforms" },
  { route: "/client/live-chart", label: "live chart" },
  { route: "/client/trading-contest", label: "trading contest" },
  { route: "/client/refer", label: "refer a friend" },
  { route: "/client/partner/dashboard", label: "partner dashboard" },
  { route: "/client/partner/create", label: "create partner account" },
  { route: "/client/partner/commission", label: "partner commission" },
  { route: "/client/partner/withdrawal", label: "partner withdrawal" },
  { route: "/client/copy/master", label: "copy trading master" },
  { route: "/client/copy/terms", label: "copy trading terms" },
  { route: "/client/copy/copier", label: "copy trading copier" },
  { route: "/client/copy/rating", label: "copy trading rating" },
];

// Canonical field/button identifiers the frontend DOM executor knows how to find
// (mirrors FIELD_ALIASES / BUTTON_TARGET_ALIASES keys in VoicePageNavigator.tsx).
const ASSISTANT_FIELD_CATALOG = [
  "leverage",
  "account type",
  "mt5 account number",
  "master password",
  "investor password",
  "amount",
  "account",
  "from account",
  "to account",
  "transaction id",
  "wallet address",
  "language",
  "voice",
  "search",
];

const ASSISTANT_BUTTON_CATALOG = [
  "create account",
  "create trading account",
  "reset account",
  "custom settings",
  "refresh",
  "request withdrawal",
  "review partner network",
  "withdrawal history",
  "copy code",
  "create partner account",
  "start copying",
  "back to masters",
  "reset filters",
  "view copiers",
  "view trades",
  "unlink",
];

const COMMAND_SUGGESTIONS = {
  "en-IN": [
    "Give me my dashboard summary",
    "What is my total balance?",
    "What is the latest forex outlook?",
    "Show my latest transactions",
    "Do I have unread notifications?",
    "Open withdrawal page",
  ],
  "hi-IN": [
    "Mera dashboard summary batao",
    "Mera total balance kya hai?",
    "Latest forex outlook batao",
    "Meri latest transactions dikhao",
    "Kya mere unread notifications hain?",
    "Withdrawal page kholo",
  ],
  "tr-TR": [
    "Panel özetimi göster",
    "Toplam bakiyem nedir?",
    "Son forex görünümünü göster",
    "Son işlemlerimi göster",
    "Okunmamış bildirimlerim var mı?",
    "Çekim sayfasını aç",
  ],
  "ar-SA": [
    "اعرض ملخص لوحة التحكم",
    "ما هو إجمالي رصيدي؟",
    "اعرض أحدث توقعات الفوركس",
    "اعرض آخر معاملاتي",
    "هل لدي إشعارات غير مقروءة؟",
    "افتح صفحة السحب",
  ],
  "ru-RU": [
    "Покажи сводку панели",
    "Какой у меня общий баланс?",
    "Покажи последний прогноз по форексу",
    "Покажи последние транзакции",
    "Есть ли у меня непрочитанные уведомления?",
    "Открой страницу вывода",
  ],
};

const MARKET_ASSETS = [...FOREX_PAIRS, ...CRYPTO_ASSETS];
const MARKET_REFRESH_HINTS = [
  "live",
  "real time",
  "realtime",
  "current",
  "now",
  "latest",
  "today",
  "price",
];
const MARKET_NEWS_HINTS = ["news", "headline", "headlines", "sentiment"];
const MARKET_DIRECTION_LABELS = {
  bullish: "bullish",
  bearish: "bearish",
  neutral: "neutral",
};
const MARKET_RECOMMENDATION_LABELS = {
  favorable: "favorable setup",
  watch: "watch setup",
  avoid: "high-risk setup",
};

function normalizeText(value = "") {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function localize(language, values) {
  return values[language] || values["en-IN"];
}

function formatMoney(value) {
  const amount = Number(value || 0);
  return `$${amount.toFixed(2)}`;
}

function formatMarketPrice(symbol, price) {
  const numericPrice = Number(price || 0);

  if (symbol.includes("JPY")) {
    return numericPrice.toFixed(3);
  }

  if (numericPrice >= 1000) {
    return numericPrice.toFixed(2);
  }

  if (numericPrice >= 1) {
    return numericPrice.toFixed(3);
  }

  return numericPrice.toFixed(5);
}

function buildMarketAliases(asset) {
  return [
    asset.symbol,
    asset.label,
    `${asset.baseCurrency} ${asset.quoteCurrency}`,
    `${asset.baseName} ${asset.quoteName}`,
    asset.baseName,
  ].map((value) => normalizeText(value));
}

function detectMarketRequest(normalizedMessage) {
  const matchedAssets = MARKET_ASSETS.filter((asset) =>
    buildMarketAliases(asset).some((alias) => alias && normalizedMessage.includes(alias)),
  );

  const hasCryptoHint = [
    "crypto",
    "bitcoin",
    "ethereum",
    "solana",
    "xrp",
    "bnb",
    "cardano",
    "btc",
    "eth",
    "sol",
    "ada",
  ].some((word) => normalizedMessage.includes(word));
  const hasForexHint = [
    "forex",
    "currency",
    "fx",
    "eur",
    "gbp",
    "jpy",
    "cad",
    "chf",
    "aud",
    "nzd",
  ].some((word) => normalizedMessage.includes(word));

  const assetType = hasCryptoHint && !hasForexHint ? "crypto" : "forex";
  const filteredSymbols = matchedAssets
    .filter((asset) => assetType === "crypto"
      ? CRYPTO_ASSETS.some((crypto) => crypto.symbol === asset.symbol)
      : FOREX_PAIRS.some((pair) => pair.symbol === asset.symbol))
    .map((asset) => asset.symbol);

  return {
    assetType,
    symbols: filteredSymbols.length > 0 ? filteredSymbols.slice(0, 3) : undefined,
    refresh: MARKET_REFRESH_HINTS.some((word) => normalizedMessage.includes(word)),
    includeNews: MARKET_NEWS_HINTS.some((word) => normalizedMessage.includes(word)),
  };
}

function buildMarketReply(language, forecastPayload, request) {
  const requestedSymbol =
    request.symbols && request.symbols.length > 0 ? request.symbols[0] : null;
  const forecasts = Array.isArray(forecastPayload?.forecasts)
    ? forecastPayload.forecasts
    : [];
  const selectedForecast =
    forecasts.find((item) => item.symbol === requestedSymbol) ||
    forecastPayload?.summary?.strongestOpportunity ||
    forecasts[0] ||
    null;

  if (!selectedForecast) {
    return localize(language, {
      "en-IN": "I could not build a usable market forecast right now.",
      "hi-IN": "Main abhi usable market forecast build nahi kar paaya.",
      "tr-TR": "Şu anda kullanılabilir bir piyasa tahmini oluşturamadım.",
      "ar-SA": "لم أتمكن من إعداد توقع سوق قابل للاستخدام الآن.",
      "ru-RU": "Сейчас не удалось собрать пригодный рыночный прогноз.",
    });
  }

  const directionLabel =
    MARKET_DIRECTION_LABELS[selectedForecast.direction] || selectedForecast.direction;
  const recommendationLabel =
    MARKET_RECOMMENDATION_LABELS[selectedForecast.recommendation] ||
    selectedForecast.recommendation;
  const priceLabel = formatMarketPrice(
    selectedForecast.symbol,
    selectedForecast.currentPrice,
  );
  const reasons = Array.isArray(selectedForecast.reasons)
    ? selectedForecast.reasons
    : [];
  const primaryReason = reasons[0] || "recent market structure";
  const riskLabel =
    selectedForecast.recommendation === "avoid"
      ? "Risk is elevated."
      : selectedForecast.recommendation === "watch"
        ? "This is a watch-only setup."
        : "This is a favorable setup, not a guaranteed move.";

  return localize(language, {
    "en-IN": `${selectedForecast.label} is currently ${directionLabel} with ${selectedForecast.confidence}% confidence. Current forecast price is ${priceLabel}, support is ${formatMarketPrice(selectedForecast.symbol, selectedForecast.support)}, resistance is ${formatMarketPrice(selectedForecast.symbol, selectedForecast.resistance)}, and the system tags it as a ${recommendationLabel}. Main reason: ${primaryReason}. ${riskLabel} This is market research, not personalized investment advice.`,
    "hi-IN": `${selectedForecast.label} abhi ${directionLabel} dikh raha hai aur confidence ${selectedForecast.confidence}% hai. Forecast price ${priceLabel}, support ${formatMarketPrice(selectedForecast.symbol, selectedForecast.support)}, resistance ${formatMarketPrice(selectedForecast.symbol, selectedForecast.resistance)} hai, aur system ise ${recommendationLabel} bol raha hai. Main reason: ${primaryReason}. ${riskLabel} Yeh market research hai, personalized investment advice nahi.`,
    "tr-TR": `${selectedForecast.label} şu anda ${directionLabel} görünüyor ve güven skoru %${selectedForecast.confidence}. Tahmini fiyat ${priceLabel}, destek ${formatMarketPrice(selectedForecast.symbol, selectedForecast.support)}, direnç ${formatMarketPrice(selectedForecast.symbol, selectedForecast.resistance)} ve sistem bunu ${recommendationLabel} olarak işaretliyor. Ana neden: ${primaryReason}. ${riskLabel} Bu çıktı kişisel yatırım tavsiyesi değil, piyasa araştırmasıdır.`,
    "ar-SA": `يظهر ${selectedForecast.label} حاليًا باتجاه ${directionLabel} وبدرجة ثقة ${selectedForecast.confidence}%. سعر التوقع ${priceLabel}، والدعم ${formatMarketPrice(selectedForecast.symbol, selectedForecast.support)}، والمقاومة ${formatMarketPrice(selectedForecast.symbol, selectedForecast.resistance)}، ويصنفه النظام على أنه ${recommendationLabel}. السبب الرئيسي: ${primaryReason}. ${riskLabel} هذا بحث سوقي وليس نصيحة استثمارية شخصية.`,
    "ru-RU": `Сейчас ${selectedForecast.label} выглядит как ${directionLabel} со степенью уверенности ${selectedForecast.confidence}%. Прогнозная цена ${priceLabel}, поддержка ${formatMarketPrice(selectedForecast.symbol, selectedForecast.support)}, сопротивление ${formatMarketPrice(selectedForecast.symbol, selectedForecast.resistance)}, а система помечает это как ${recommendationLabel}. Главная причина: ${primaryReason}. ${riskLabel} Это рыночная аналитика, а не персональная инвестиционная рекомендация.`,
  });
}

function buildRecentActivity(deposits, withdrawals, transfers) {
  const items = [];

  deposits.forEach((deposit) => {
    items.push({
      id: String(deposit._id),
      type: "deposit",
      amount: Number(deposit.amount || 0),
      status: deposit.status,
      account: deposit.account?.mt5Account || null,
      date: deposit.createdAt || deposit.requestedDate,
      description: `Deposit ${deposit.status.toLowerCase()}`,
    });
  });

  withdrawals.forEach((withdrawal) => {
    items.push({
      id: String(withdrawal._id),
      type: "withdrawal",
      amount: Number(withdrawal.amount || 0),
      status: withdrawal.status,
      account: withdrawal.account?.mt5Account || null,
      date: withdrawal.createdAt || withdrawal.requestedDate,
      description: `Withdrawal ${withdrawal.status.toLowerCase()}`,
    });
  });

  transfers.forEach((transfer) => {
    items.push({
      id: String(transfer._id),
      type: "transfer",
      amount: Number(transfer.amount || 0),
      status: transfer.status,
      account:
        transfer.fromAccount?.mt5Account && transfer.toAccount?.mt5Account
          ? `${transfer.fromAccount.mt5Account} -> ${transfer.toAccount.mt5Account}`
          : null,
      date: transfer.createdAt,
      description: "Internal transfer",
    });
  });

  return items
    .sort((left, right) => new Date(right.date) - new Date(left.date))
    .slice(0, 8);
}

async function buildAssistantContext(userId) {
  const cacheKey = getAssistantContextCacheKey(userId);
  const cached = await cacheService.get(cacheKey);
  if (cached) {
    return cached;
  }

  const objectUserId = new mongoose.Types.ObjectId(userId);

  const [
    user,
    profile,
    accounts,
    accountOverview,
    depositOverview,
    recentDeposits,
    withdrawalOverview,
    recentWithdrawals,
    recentTransfers,
    unreadNotifications,
    totalNotifications,
    recentNotifications,
    openTickets,
    totalTickets,
    recentTickets,
  ] = await Promise.all([
    User.findById(userId)
      .select("firstName lastName email role createdAt")
      .lean(),
    Profile.findOne({ user: userId }).select("kycStatus kycVerified").lean(),
    Account.find({ user: userId })
      .select(
        "mt5Account name accountType platform balance equity status leverage createdAt",
      )
      .sort({ createdAt: -1 })
      .lean(),
    Account.aggregate([
      { $match: { user: objectUserId } },
      {
        $group: {
          _id: null,
          totalBalance: { $sum: "$balance" },
          totalEquity: { $sum: "$equity" },
          totalAccounts: { $sum: 1 },
          activeAccounts: {
            $sum: {
              $cond: [{ $eq: ["$status", true] }, 1, 0],
            },
          },
        },
      },
    ]),
    Deposit.aggregate([
      { $match: { user: objectUserId } },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          amount: { $sum: "$amount" },
        },
      },
    ]),
    Deposit.find({ user: userId })
      .select("amount status createdAt approvedDate requestedDate account")
      .populate("account", "mt5Account")
      .sort({ createdAt: -1 })
      .limit(5)
      .lean(),
    Withdrawal.aggregate([
      { $match: { user: objectUserId } },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          amount: { $sum: "$amount" },
        },
      },
    ]),
    Withdrawal.find({ user: userId })
      .select("amount status createdAt approvedDate requestedDate account")
      .populate("account", "mt5Account")
      .sort({ createdAt: -1 })
      .limit(5)
      .lean(),
    Transfer.find({ user: userId })
      .select("amount status createdAt fromAccount toAccount")
      .populate("fromAccount", "mt5Account")
      .populate("toAccount", "mt5Account")
      .sort({ createdAt: -1 })
      .limit(5)
      .lean(),
    Notification.countDocuments({ recipient: userId, read: false }),
    Notification.countDocuments({ recipient: userId }),
    Notification.find({ recipient: userId })
      .select("title message type read createdAt")
      .sort({ createdAt: -1 })
      .limit(5)
      .lean(),
    Ticket.countDocuments({
      createdBy: userId,
      status: { $in: ["new", "open", "inProgress"] },
    }),
    Ticket.countDocuments({ createdBy: userId }),
    Ticket.find({ createdBy: userId })
      .select("ticketNumber subject status priority category updatedAt")
      .sort({ updatedAt: -1 })
      .limit(5)
      .lean(),
  ]);

  const accountBase = accountOverview[0] || {
    totalBalance: 0,
    totalEquity: 0,
    totalAccounts: 0,
    activeAccounts: 0,
  };

  const getStatusStats = (items, status) => {
    const match = items.find((item) => item._id === status);
    return {
      count: match?.count || 0,
      amount: match?.amount || 0,
    };
  };

  const approvedDeposits = getStatusStats(depositOverview, "Approved");
  const pendingDeposits = getStatusStats(depositOverview, "Pending");
  const rejectedDeposits = getStatusStats(depositOverview, "Rejected");
  const approvedWithdrawals = getStatusStats(withdrawalOverview, "Approved");
  const pendingWithdrawals = getStatusStats(withdrawalOverview, "Pending");
  const rejectedWithdrawals = getStatusStats(withdrawalOverview, "Rejected");

  const mt5Accounts = accounts.filter((account) =>
    `${account.platform || account.accountType || ""}`.toLowerCase().includes("mt5"),
  ).length;
  const mt4Accounts = accounts.filter((account) =>
    `${account.platform || account.accountType || ""}`.toLowerCase().includes("mt4"),
  ).length;

  const overview = {
    totalBalance: Number(accountBase.totalBalance || 0),
    totalEquity: Number(accountBase.totalEquity || 0),
    totalDeposits: Number(approvedDeposits.amount || 0),
    totalWithdrawals: Number(approvedWithdrawals.amount || 0),
    netBalance: Number(accountBase.totalBalance || 0) + Number(accountBase.totalEquity || 0),
  };

  const result = {
    profile: {
      fullName: `${user?.firstName || ""} ${user?.lastName || ""}`.trim() || "Client",
      email: user?.email || "",
      role: user?.role || "client",
      joinedAt: user?.createdAt || null,
      kycStatus: profile?.kycStatus || "unverified",
      kycVerified: Boolean(profile?.kycVerified),
    },
    overview,
    accounts: {
      total: accountBase.totalAccounts || 0,
      active: accountBase.activeAccounts || 0,
      mt5: mt5Accounts,
      mt4: mt4Accounts,
      recent: accounts.slice(0, 5).map((account) => ({
        mt5Account: account.mt5Account,
        name: account.name,
        accountType: account.accountType,
        platform: account.platform,
        leverage: account.leverage,
        balance: Number(account.balance || 0),
        equity: Number(account.equity || 0),
        status: Boolean(account.status),
      })),
    },
    deposits: {
      approvedCount: approvedDeposits.count,
      pendingCount: pendingDeposits.count,
      rejectedCount: rejectedDeposits.count,
      totalApprovedAmount: Number(approvedDeposits.amount || 0),
      totalPendingAmount: Number(pendingDeposits.amount || 0),
      recent: recentDeposits.map((deposit) => ({
        id: String(deposit._id),
        amount: Number(deposit.amount || 0),
        status: deposit.status,
        account: deposit.account?.mt5Account || null,
        date: deposit.createdAt || deposit.requestedDate || deposit.approvedDate,
      })),
    },
    withdrawals: {
      approvedCount: approvedWithdrawals.count,
      pendingCount: pendingWithdrawals.count,
      rejectedCount: rejectedWithdrawals.count,
      totalApprovedAmount: Number(approvedWithdrawals.amount || 0),
      totalPendingAmount: Number(pendingWithdrawals.amount || 0),
      recent: recentWithdrawals.map((withdrawal) => ({
        id: String(withdrawal._id),
        amount: Number(withdrawal.amount || 0),
        status: withdrawal.status,
        account: withdrawal.account?.mt5Account || null,
        date:
          withdrawal.createdAt ||
          withdrawal.requestedDate ||
          withdrawal.approvedDate,
      })),
    },
    transactions: {
      total: recentDeposits.length + recentWithdrawals.length + recentTransfers.length,
      recent: buildRecentActivity(recentDeposits, recentWithdrawals, recentTransfers),
    },
    notifications: {
      unreadCount: unreadNotifications,
      totalCount: totalNotifications,
      recent: recentNotifications.map((notification) => ({
        id: String(notification._id),
        title: notification.title,
        message: notification.message,
        type: notification.type,
        read: notification.read,
        createdAt: notification.createdAt,
      })),
    },
    tickets: {
      openCount: openTickets,
      totalCount: totalTickets,
      recent: recentTickets.map((ticket) => ({
        id: String(ticket._id),
        ticketNumber: ticket.ticketNumber,
        subject: ticket.subject,
        status: ticket.status,
        priority: ticket.priority,
        category: ticket.category,
        updatedAt: ticket.updatedAt,
      })),
    },
  };

  await cacheService.set(cacheKey, result, ASSISTANT_CONTEXT_TTL_SECONDS);
  return result;
}

function detectRoute(normalizedMessage) {
  for (const [label, route] of Object.entries(PAGE_ROUTES)) {
    if (normalizedMessage.includes(label)) {
      return { label, route };
    }
  }

  return null;
}

function detectTopic(message, historyText = "") {
  const topicRules = [
    {
      topic: "navigation",
      words: ["open", "go to", "navigate", "show page", "kholo", "افتح", "открой"],
    },
    {
      topic: "dashboard",
      words: ["dashboard", "summary", "overview", "crm", "everything", "all data", "لوحة", "сводка"],
    },
    {
      topic: "balance",
      words: ["balance", "equity", "wallet", "funds", "money", "الرصيد", "баланс"],
    },
    {
      topic: "deposit",
      words: ["deposit", "deposits", "credited", "payment", "إيداع", "депозит"],
    },
    {
      topic: "withdrawal",
      words: ["withdraw", "withdrawal", "cashout", "سحب", "вывод"],
    },
    {
      topic: "account",
      words: ["account", "accounts", "mt5", "mt4", "login id", "الحساب", "счет"],
    },
    {
      topic: "transaction",
      words: ["transaction", "history", "recent activity", "statement", "المعاملات", "транзак"],
    },
    {
      topic: "market",
      words: [
        "forex",
        "fx",
        "market",
        "signal",
        "forecast",
        "pair",
        "crypto",
        "bitcoin",
        "ethereum",
        "eurusd",
        "gbpusd",
        "usdjpy",
      ],
    },
    {
      topic: "notification",
      words: ["notification", "notifications", "alert", "unread", "إشعار", "уведом"],
    },
    {
      topic: "ticket",
      words: ["ticket", "support", "complaint", "issue", "تذكرة", "поддерж"],
    },
    {
      topic: "profile",
      words: ["profile", "kyc", "email", "name", "who am i", "الملف", "профиль"],
    },
    {
      topic: "help",
      words: ["help", "assist", "what can you do", "مساعدة", "помощь"],
    },
  ];

  const matchedFromMessage = topicRules.find((rule) =>
    rule.words.some((word) => message.includes(word)),
  );

  if (matchedFromMessage) {
    return matchedFromMessage.topic;
  }

  const combined = `${historyText} ${message}`.trim();
  const matchedFromCombined = topicRules.find((rule) =>
    rule.words.some((word) => combined.includes(word)),
  );

  return matchedFromCombined?.topic || "unknown";
}

function buildReply(topic, context, language, navigation) {
  const profile = context.profile;
  const overview = context.overview;
  const recentTransaction = context.transactions.recent[0];
  const latestNotification = context.notifications.recent[0];
  const latestTicket = context.tickets.recent[0];

  switch (topic) {
    case "navigation":
      if (!navigation) {
        return localize(language, {
          "en-IN": "Tell me which CRM page you want to open, for example dashboard, deposit, withdrawal, profile, or support.",
          "hi-IN": "Batayiye kaunsi CRM page kholni hai, jaise dashboard, deposit, withdrawal, profile ya support.",
          "tr-TR": "Hangi CRM sayfasını açmak istediğinizi söyleyin. Örneğin panel, yatırım, çekim, profil veya destek.",
          "ar-SA": "أخبرني أي صفحة CRM تريد فتحها مثل لوحة التحكم أو الإيداع أو السحب أو الملف الشخصي أو الدعم.",
          "ru-RU": "Скажите, какую страницу CRM открыть: панель, депозит, вывод, профиль или поддержка.",
        });
      }

      return localize(language, {
        "en-IN": `Opening ${navigation.label} page for you.`,
        "hi-IN": `Main ${navigation.label} page khol raha hoon.`,
        "tr-TR": `${navigation.label} sayfasını açıyorum.`,
        "ar-SA": `جاري فتح صفحة ${navigation.label} لك.`,
        "ru-RU": `Открываю страницу ${navigation.label}.`,
      });
    case "dashboard":
      return localize(language, {
        "en-IN": `Your CRM summary shows balance ${formatMoney(overview.totalBalance)}, equity ${formatMoney(overview.totalEquity)}, approved deposits ${formatMoney(overview.totalDeposits)}, approved withdrawals ${formatMoney(overview.totalWithdrawals)}, ${context.accounts.total} accounts, ${context.notifications.unreadCount} unread notifications, and ${context.tickets.openCount} open support tickets.${recentTransaction ? ` Latest activity is ${recentTransaction.description} for ${formatMoney(recentTransaction.amount)} with status ${recentTransaction.status}.` : ""}`,
        "hi-IN": `Aapke CRM summary me balance ${formatMoney(overview.totalBalance)}, equity ${formatMoney(overview.totalEquity)}, approved deposits ${formatMoney(overview.totalDeposits)}, approved withdrawals ${formatMoney(overview.totalWithdrawals)}, ${context.accounts.total} accounts, ${context.notifications.unreadCount} unread notifications aur ${context.tickets.openCount} open support tickets dikh rahe hain.${recentTransaction ? ` Latest activity ${recentTransaction.description} hai, amount ${formatMoney(recentTransaction.amount)} aur status ${recentTransaction.status}.` : ""}`,
        "tr-TR": `CRM özetinizde bakiye ${formatMoney(overview.totalBalance)}, öz sermaye ${formatMoney(overview.totalEquity)}, onaylı yatırımlar ${formatMoney(overview.totalDeposits)}, onaylı çekimler ${formatMoney(overview.totalWithdrawals)}, ${context.accounts.total} hesap, ${context.notifications.unreadCount} okunmamış bildirim ve ${context.tickets.openCount} açık destek talebi görünüyor.${recentTransaction ? ` Son hareket ${recentTransaction.description}, tutar ${formatMoney(recentTransaction.amount)} ve durum ${recentTransaction.status}.` : ""}`,
        "ar-SA": `يعرض ملخص CRM الخاص بك رصيدًا بقيمة ${formatMoney(overview.totalBalance)}، وحقوق ملكية ${formatMoney(overview.totalEquity)}، وإيداعات معتمدة ${formatMoney(overview.totalDeposits)}، وسحوبات معتمدة ${formatMoney(overview.totalWithdrawals)}، و${context.accounts.total} حسابات، و${context.notifications.unreadCount} إشعارات غير مقروءة، و${context.tickets.openCount} تذاكر دعم مفتوحة.${recentTransaction ? ` آخر نشاط هو ${recentTransaction.description} بمبلغ ${formatMoney(recentTransaction.amount)} وحالة ${recentTransaction.status}.` : ""}`,
        "ru-RU": `Сводка CRM показывает баланс ${formatMoney(overview.totalBalance)}, капитал ${formatMoney(overview.totalEquity)}, подтвержденные депозиты ${formatMoney(overview.totalDeposits)}, подтвержденные выводы ${formatMoney(overview.totalWithdrawals)}, ${context.accounts.total} счетов, ${context.notifications.unreadCount} непрочитанных уведомлений и ${context.tickets.openCount} открытых тикетов поддержки.${recentTransaction ? ` Последняя активность: ${recentTransaction.description}, сумма ${formatMoney(recentTransaction.amount)}, статус ${recentTransaction.status}.` : ""}`,
      });
    case "balance":
      return localize(language, {
        "en-IN": `Your current balance is ${formatMoney(overview.totalBalance)} and your total equity is ${formatMoney(overview.totalEquity)}.`,
        "hi-IN": `Aapka current balance ${formatMoney(overview.totalBalance)} hai aur total equity ${formatMoney(overview.totalEquity)} hai.`,
        "tr-TR": `Güncel bakiyeniz ${formatMoney(overview.totalBalance)} ve toplam öz sermayeniz ${formatMoney(overview.totalEquity)}.`,
        "ar-SA": `رصيدك الحالي هو ${formatMoney(overview.totalBalance)} وإجمالي حقوق الملكية ${formatMoney(overview.totalEquity)}.`,
        "ru-RU": `Ваш текущий баланс ${formatMoney(overview.totalBalance)}, а общий капитал ${formatMoney(overview.totalEquity)}.`,
      });
    case "deposit":
      return localize(language, {
        "en-IN": `You have ${context.deposits.approvedCount} approved deposits worth ${formatMoney(context.deposits.totalApprovedAmount)} and ${context.deposits.pendingCount} pending deposits worth ${formatMoney(context.deposits.totalPendingAmount)}.`,
        "hi-IN": `Aapke ${context.deposits.approvedCount} approved deposits hain jinki total value ${formatMoney(context.deposits.totalApprovedAmount)} hai aur ${context.deposits.pendingCount} pending deposits ${formatMoney(context.deposits.totalPendingAmount)} ke hain.`,
        "tr-TR": `${context.deposits.approvedCount} onaylı yatırımınız var ve toplam tutarı ${formatMoney(context.deposits.totalApprovedAmount)}. Bekleyen yatırım sayınız ${context.deposits.pendingCount} ve tutarı ${formatMoney(context.deposits.totalPendingAmount)}.`,
        "ar-SA": `لديك ${context.deposits.approvedCount} إيداعات معتمدة بقيمة ${formatMoney(context.deposits.totalApprovedAmount)} و${context.deposits.pendingCount} إيداعات قيد الانتظار بقيمة ${formatMoney(context.deposits.totalPendingAmount)}.`,
        "ru-RU": `У вас ${context.deposits.approvedCount} подтвержденных депозитов на сумму ${formatMoney(context.deposits.totalApprovedAmount)} и ${context.deposits.pendingCount} ожидающих депозитов на сумму ${formatMoney(context.deposits.totalPendingAmount)}.`,
      });
    case "withdrawal":
      return localize(language, {
        "en-IN": `You have ${context.withdrawals.approvedCount} approved withdrawals worth ${formatMoney(context.withdrawals.totalApprovedAmount)} and ${context.withdrawals.pendingCount} pending withdrawals worth ${formatMoney(context.withdrawals.totalPendingAmount)}.`,
        "hi-IN": `Aapke ${context.withdrawals.approvedCount} approved withdrawals hain jinki total value ${formatMoney(context.withdrawals.totalApprovedAmount)} hai aur ${context.withdrawals.pendingCount} pending withdrawals ${formatMoney(context.withdrawals.totalPendingAmount)} ke hain.`,
        "tr-TR": `${context.withdrawals.approvedCount} onaylı çekiminiz var ve toplam tutarı ${formatMoney(context.withdrawals.totalApprovedAmount)}. Bekleyen çekim sayınız ${context.withdrawals.pendingCount} ve tutarı ${formatMoney(context.withdrawals.totalPendingAmount)}.`,
        "ar-SA": `لديك ${context.withdrawals.approvedCount} سحوبات معتمدة بقيمة ${formatMoney(context.withdrawals.totalApprovedAmount)} و${context.withdrawals.pendingCount} سحوبات قيد الانتظار بقيمة ${formatMoney(context.withdrawals.totalPendingAmount)}.`,
        "ru-RU": `У вас ${context.withdrawals.approvedCount} подтвержденных выводов на сумму ${formatMoney(context.withdrawals.totalApprovedAmount)} и ${context.withdrawals.pendingCount} ожидающих выводов на сумму ${formatMoney(context.withdrawals.totalPendingAmount)}.`,
      });
    case "account":
      return localize(language, {
        "en-IN": `You have ${context.accounts.total} CRM accounts, ${context.accounts.active} active, with ${context.accounts.mt5} MT5 and ${context.accounts.mt4} MT4 profiles.`,
        "hi-IN": `Aapke paas ${context.accounts.total} CRM accounts hain, jinme ${context.accounts.active} active hain, aur ${context.accounts.mt5} MT5 aur ${context.accounts.mt4} MT4 profiles hain.`,
        "tr-TR": `${context.accounts.total} CRM hesabınız var, bunların ${context.accounts.active} tanesi aktif. ${context.accounts.mt5} MT5 ve ${context.accounts.mt4} MT4 profiliniz bulunuyor.`,
        "ar-SA": `لديك ${context.accounts.total} حسابات CRM، منها ${context.accounts.active} نشطة، وتشمل ${context.accounts.mt5} حسابات MT5 و${context.accounts.mt4} حسابات MT4.`,
        "ru-RU": `У вас ${context.accounts.total} счетов CRM, ${context.accounts.active} из них активны, включая ${context.accounts.mt5} MT5 и ${context.accounts.mt4} MT4.`,
      });
    case "transaction":
      return localize(language, {
        "en-IN": recentTransaction
          ? `Your latest CRM activity is ${recentTransaction.description} for ${formatMoney(recentTransaction.amount)} with status ${recentTransaction.status}.`
          : "I do not see recent CRM transactions right now.",
        "hi-IN": recentTransaction
          ? `Aapki latest CRM activity ${recentTransaction.description} hai, amount ${formatMoney(recentTransaction.amount)} aur status ${recentTransaction.status} hai.`
          : "Mujhe abhi recent CRM transactions nahi dikh rahi hain.",
        "tr-TR": recentTransaction
          ? `Son CRM hareketiniz ${recentTransaction.description}, tutar ${formatMoney(recentTransaction.amount)} ve durum ${recentTransaction.status}.`
          : "Şu anda son CRM işlemleri görünmüyor.",
        "ar-SA": recentTransaction
          ? `آخر نشاط في CRM هو ${recentTransaction.description} بمبلغ ${formatMoney(recentTransaction.amount)} وحالة ${recentTransaction.status}.`
          : "لا أرى معاملات CRM حديثة الآن.",
        "ru-RU": recentTransaction
          ? `Последняя активность CRM: ${recentTransaction.description}, сумма ${formatMoney(recentTransaction.amount)}, статус ${recentTransaction.status}.`
          : "Сейчас я не вижу недавних транзакций CRM.",
      });
    case "notification":
      return localize(language, {
        "en-IN": latestNotification
          ? `You have ${context.notifications.unreadCount} unread notifications. Latest alert: ${latestNotification.title}.`
          : "You do not have recent CRM notifications.",
        "hi-IN": latestNotification
          ? `Aapke ${context.notifications.unreadCount} unread notifications hain. Latest alert: ${latestNotification.title}.`
          : "Aapke recent CRM notifications nahi hain.",
        "tr-TR": latestNotification
          ? `${context.notifications.unreadCount} okunmamış bildiriminiz var. Son bildirim: ${latestNotification.title}.`
          : "Son CRM bildiriminiz görünmüyor.",
        "ar-SA": latestNotification
          ? `لديك ${context.notifications.unreadCount} إشعارات غير مقروءة. آخر تنبيه هو: ${latestNotification.title}.`
          : "لا توجد إشعارات CRM حديثة لديك.",
        "ru-RU": latestNotification
          ? `У вас ${context.notifications.unreadCount} непрочитанных уведомлений. Последнее: ${latestNotification.title}.`
          : "Недавних уведомлений CRM нет.",
      });
    case "ticket":
      return localize(language, {
        "en-IN": latestTicket
          ? `You currently have ${context.tickets.openCount} open support tickets. Latest ticket ${latestTicket.ticketNumber} is ${latestTicket.status}.`
          : `You currently have ${context.tickets.openCount} open support tickets.`,
        "hi-IN": latestTicket
          ? `Aapke paas abhi ${context.tickets.openCount} open support tickets hain. Latest ticket ${latestTicket.ticketNumber} ka status ${latestTicket.status} hai.`
          : `Aapke paas abhi ${context.tickets.openCount} open support tickets hain.`,
        "tr-TR": latestTicket
          ? `Şu anda ${context.tickets.openCount} açık destek talebiniz var. Son talep ${latestTicket.ticketNumber} ve durumu ${latestTicket.status}.`
          : `Şu anda ${context.tickets.openCount} açık destek talebiniz var.`,
        "ar-SA": latestTicket
          ? `لديك حاليًا ${context.tickets.openCount} تذاكر دعم مفتوحة. أحدث تذكرة ${latestTicket.ticketNumber} وحالتها ${latestTicket.status}.`
          : `لديك حاليًا ${context.tickets.openCount} تذاكر دعم مفتوحة.`,
        "ru-RU": latestTicket
          ? `Сейчас у вас ${context.tickets.openCount} открытых тикетов поддержки. Последний тикет ${latestTicket.ticketNumber} имеет статус ${latestTicket.status}.`
          : `Сейчас у вас ${context.tickets.openCount} открытых тикетов поддержки.`,
      });
    case "profile":
      return localize(language, {
        "en-IN": `Your CRM profile shows ${profile.fullName}, email ${profile.email}, and KYC status ${profile.kycStatus}.`,
        "hi-IN": `Aapke CRM profile me ${profile.fullName}, email ${profile.email}, aur KYC status ${profile.kycStatus} dikh raha hai.`,
        "tr-TR": `CRM profilinizde ${profile.fullName}, e-posta ${profile.email} ve KYC durumu ${profile.kycStatus} görünüyor.`,
        "ar-SA": `يُظهر ملف CRM الخاص بك الاسم ${profile.fullName} والبريد الإلكتروني ${profile.email} وحالة KYC ${profile.kycStatus}.`,
        "ru-RU": `В вашем профиле CRM указаны ${profile.fullName}, почта ${profile.email} и статус KYC ${profile.kycStatus}.`,
      });
    case "help":
      return localize(language, {
        "en-IN": "I can answer questions about your balance, dashboard, deposits, withdrawals, accounts, transactions, notifications, support tickets, profile, live forex or crypto outlooks, and I can open CRM pages for you.",
        "hi-IN": "Main aapke balance, dashboard, deposits, withdrawals, accounts, transactions, notifications, support tickets, profile, live forex ya crypto outlooks aur CRM page navigation me help kar sakta hoon.",
        "tr-TR": "Bakiye, panel, yatırımlar, çekimler, hesaplar, işlemler, bildirimler, destek talepleri, profil, canlı forex veya kripto görünümü ve CRM sayfa açma konularında yardımcı olabilirim.",
        "ar-SA": "يمكنني الإجابة عن الرصيد ولوحة التحكم والإيداعات والسحوبات والحسابات والمعاملات والإشعارات وتذاكر الدعم والملف الشخصي ونظرة الفوركس أو العملات الرقمية الحية وفتح صفحات CRM لك.",
        "ru-RU": "Я могу отвечать по балансу, панели, депозитам, выводам, счетам, транзакциям, уведомлениям, тикетам поддержки, профилю, живому обзору форекса или крипто и открывать страницы CRM.",
      });
    default:
      return localize(language, {
        "en-IN": "I answer from your CRM data, CRM backend activity, and the built-in market forecast service. Ask about dashboard, balance, deposits, withdrawals, accounts, transactions, notifications, tickets, profile, forex outlook, crypto outlook, or tell me which CRM page to open.",
        "hi-IN": "Main aapke CRM data, CRM backend activity aur built-in market forecast service se answer deta hoon. Dashboard, balance, deposits, withdrawals, accounts, transactions, notifications, tickets, profile, forex outlook, crypto outlook ya CRM page ke bare me poochiye.",
        "tr-TR": "CRM verileriniz, CRM arka uç etkinliğiniz ve yerleşik piyasa tahmin servisi üzerinden yanıt veririm. Panel, bakiye, yatırımlar, çekimler, hesaplar, işlemler, bildirimler, talepler, profil, forex görünümü, kripto görünümü veya açılacak CRM sayfasını sorun.",
        "ar-SA": "أجيب من بيانات CRM الخاصة بك ونشاط الواجهة الخلفية للـ CRM ومن خدمة توقعات السوق المدمجة. اسأل عن لوحة التحكم أو الرصيد أو الإيداعات أو السحوبات أو الحسابات أو المعاملات أو الإشعارات أو التذاكر أو الملف الشخصي أو توقعات الفوركس أو توقعات العملات الرقمية أو أخبرني بصفحة CRM التي تريد فتحها.",
        "ru-RU": "Я отвечаю на основе ваших данных CRM, активности CRM backend и встроенного сервиса рыночных прогнозов. Спросите о панели, балансе, депозитах, выводах, счетах, транзакциях, уведомлениях, тикетах, профиле, прогнозе форекса, прогнозе крипто или скажите, какую страницу CRM открыть.",
      });
  }
}

function buildAssistantUnavailableReply(language) {
  return localize(language, {
    "en-IN":
      "AI assistant is not configured in the backend yet. Add AI_API_KEY or GROQ_API_KEY to the backend environment to enable responses.",
    "hi-IN":
      "AI assistant abhi backend me configured nahi hai. Responses enable karne ke liye backend environment me AI_API_KEY ya GROQ_API_KEY add kijiye.",
    "tr-TR":
      "Yapay zeka asistanı henüz backend tarafında yapılandırılmadı. Yanıtları etkinleştirmek için backend ortamına AI_API_KEY veya GROQ_API_KEY ekleyin.",
    "ar-SA":
      "مساعد الذكاء الاصطناعي غير مهيأ بعد في الواجهة الخلفية. أضف AI_API_KEY أو GROQ_API_KEY إلى بيئة الواجهة الخلفية لتفعيل الردود.",
    "ru-RU":
      "AI-ассистент пока не настроен в backend. Добавьте AI_API_KEY или GROQ_API_KEY в переменные окружения backend, чтобы включить ответы.",
  });
}

exports.getAssistantContext = async (req, res, next) => {
  try {
    const language = req.query.language || "en-IN";
    const context = await buildAssistantContext(req.user.id);
    const welcomeMessage = localize(language, {
      "en-IN": `Welcome back ${context.profile.fullName}. Your current CRM balance is ${formatMoney(context.overview.totalBalance)}. How can I assist you inside your CRM today?`,
      "hi-IN": `Welcome back ${context.profile.fullName}. Aapka current CRM balance ${formatMoney(context.overview.totalBalance)} hai. Aaj main aapke CRM me kis tarah help karoon?`,
      "tr-TR": `Tekrar hoş geldiniz ${context.profile.fullName}. Güncel CRM bakiyeniz ${formatMoney(context.overview.totalBalance)}. Bugün CRM içinde size nasıl yardımcı olabilirim?`,
      "ar-SA": `مرحبًا بعودتك ${context.profile.fullName}. رصيد CRM الحالي لديك هو ${formatMoney(context.overview.totalBalance)}. كيف يمكنني مساعدتك داخل CRM اليوم؟`,
      "ru-RU": `С возвращением, ${context.profile.fullName}. Ваш текущий баланс CRM составляет ${formatMoney(context.overview.totalBalance)}. Чем помочь вам в CRM сегодня?`,
    });

    res.status(200).json({
      success: true,
      data: {
        ...context,
        welcomeMessage,
        suggestions: COMMAND_SUGGESTIONS[language] || COMMAND_SUGGESTIONS["en-IN"],
      },
    });
  } catch (error) {
    next(new AppError("Failed to load assistant context", 500));
  }
};

exports.chatWithAssistant = async (req, res, next) => {
  try {
    const { message = "", language = "en-IN", history = [] } = req.body || {};
    const normalizedMessage = normalizeText(message);

    if (!normalizedMessage) {
      return res.status(400).json({
        success: false,
        message: "Message is required",
      });
    }

    const historyText = Array.isArray(history)
      ? history
          .slice(-4)
          .map((entry) => normalizeText(entry?.text || ""))
          .join(" ")
      : "";

    const context = await buildAssistantContext(req.user.id);
    const sentiment = analyzeAssistantSentiment(message, history);
    const navigation = detectRoute(normalizedMessage);
    const topic = detectTopic(normalizedMessage, historyText);
    const resolvedTopic = navigation ? "navigation" : topic;
    const marketRequest = detectMarketRequest(normalizedMessage);
    const marketData =
      resolvedTopic === "market"
        ? await getMarketForecast(marketRequest).catch((error) => ({
            error: error.message || "Market forecast is unavailable.",
            assetType: marketRequest.assetType,
            symbols: marketRequest.symbols || [],
          }))
        : null;
    const fallbackReply =
      resolvedTopic === "market" && marketData && !marketData.error
        ? buildMarketReply(language, marketData, marketRequest)
        : buildReply(resolvedTopic, context, language, navigation);
    let reply = fallbackReply;
    let resolvedNavigation = navigation;
    let actions = [];

    if (isOpenAIConfigured()) {
      try {
        const aiResult = await generateAssistantIntent({
          message,
          language,
          history,
          context,
          marketData,
          topic: resolvedTopic,
          sentiment,
          routeCatalog: ASSISTANT_ROUTE_CATALOG,
          fieldCatalog: ASSISTANT_FIELD_CATALOG,
          buttonCatalog: ASSISTANT_BUTTON_CATALOG,
        });
        reply = prefixReplyWithSentiment(aiResult.reply, sentiment, language);
        resolvedNavigation = aiResult.navigation || navigation;
        actions = aiResult.actions || [];
      } catch (error) {
        const shouldFallbackToLocalReply =
          error?.code === "AI_NOT_CONFIGURED" ||
          error?.statusCode === 429 ||
          error?.statusCode === 401 ||
          error?.statusCode === 403;

        if (!shouldFallbackToLocalReply) {
          throw error;
        }

        console.error("Assistant AI fallback:", error.message || error);
      }
    } else if (resolvedTopic === "unknown" || resolvedTopic === "market") {
      reply = buildAssistantUnavailableReply(language);
    }

    reply = prefixReplyWithSentiment(reply, sentiment, language);

    res.status(200).json({
      success: true,
      data: {
        reply,
        topic: resolvedTopic,
        sentiment,
        navigation: resolvedNavigation,
        actions,
        suggestions: COMMAND_SUGGESTIONS[language] || COMMAND_SUGGESTIONS["en-IN"],
        context,
      },
    });
  } catch (error) {
    next(new AppError("Failed to process assistant message", 500));
  }
};
