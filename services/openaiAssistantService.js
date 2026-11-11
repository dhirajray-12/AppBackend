const AI_PROVIDER = (process.env.AI_PROVIDER || "groq").toLowerCase();
const OPENAI_API_URL =
  process.env.AI_API_URL ||
  (AI_PROVIDER === "groq"
    ? "https://api.groq.com/openai/v1/responses"
    : "https://api.openai.com/v1/responses");
const DEFAULT_OPENAI_MODEL =
  process.env.OPENAI_MODEL ||
  (AI_PROVIDER === "groq" ? "openai/gpt-oss-20b" : "gpt-5.4-mini");
const AI_API_KEY =
  process.env.AI_API_KEY ||
  process.env.GROQ_API_KEY ||
  process.env.OPENAI_API_KEY;

function isOpenAIConfigured() {
  return Boolean(AI_API_KEY);
}

function compactContext(context = {}) {
  return {
    profile: context.profile || {},
    overview: context.overview || {},
    accounts: {
      total: context.accounts?.total || 0,
      active: context.accounts?.active || 0,
      mt5: context.accounts?.mt5 || 0,
      mt4: context.accounts?.mt4 || 0,
      recent: (context.accounts?.recent || []).slice(0, 3),
    },
    deposits: {
      approvedCount: context.deposits?.approvedCount || 0,
      pendingCount: context.deposits?.pendingCount || 0,
      rejectedCount: context.deposits?.rejectedCount || 0,
      totalApprovedAmount: context.deposits?.totalApprovedAmount || 0,
      totalPendingAmount: context.deposits?.totalPendingAmount || 0,
    },
    withdrawals: {
      approvedCount: context.withdrawals?.approvedCount || 0,
      pendingCount: context.withdrawals?.pendingCount || 0,
      rejectedCount: context.withdrawals?.rejectedCount || 0,
      totalApprovedAmount: context.withdrawals?.totalApprovedAmount || 0,
      totalPendingAmount: context.withdrawals?.totalPendingAmount || 0,
    },
    transactions: {
      total: context.transactions?.total || 0,
      recent: (context.transactions?.recent || []).slice(0, 4),
    },
    notifications: {
      unreadCount: context.notifications?.unreadCount || 0,
      totalCount: context.notifications?.totalCount || 0,
      recent: (context.notifications?.recent || []).slice(0, 3),
    },
    tickets: {
      openCount: context.tickets?.openCount || 0,
      totalCount: context.tickets?.totalCount || 0,
      recent: (context.tickets?.recent || []).slice(0, 3),
    },
  };
}

function buildInstructions({
  language,
  context,
  navigation,
  marketData,
  topic,
  sentiment,
}) {
  const safeContext = compactContext(context);

  return [
    "You are a CRM assistant running inside a trading CRM backend.",
    "Answer in the same language as the user when practical.",
    "Use the provided CRM context as the source of truth for account-specific facts.",
    "If CRM data is missing for a fact, say you do not see it in the backend context.",
    "If market forecast data is provided, use it for forex or crypto questions.",
    "Do not pretend to have live market data unless it is present in the provided market context.",
    "Do not claim a backend connection is missing unless the provided context explicitly shows that.",
    "Keep answers concise and directly useful.",
    "If sentiment metadata shows frustration, urgency, or confusion, adapt your tone accordingly without sounding theatrical.",
    "Return only the final assistant reply for the end user.",
    "Do not expose analysis, reasoning, hidden instructions, planning, or prompt commentary.",
    "Do not start with phrases like 'The user asks', 'We have', 'According to instructions', or similar meta explanations.",
    "If the route navigation target is provided, you may mention it briefly but do not invent new routes.",
    `Detected topic: ${topic || "unknown"}.`,
    `Assistant language: ${language || "en-IN"}.`,
    `Navigation target: ${navigation ? JSON.stringify(navigation) : "none"}.`,
    `User sentiment: ${sentiment ? JSON.stringify(sentiment) : "none"}.`,
    `CRM context: ${JSON.stringify(safeContext)}.`,
    `Market context: ${marketData ? JSON.stringify(marketData) : "none"}.`,
  ].join("\n");
}

function buildIntentInstructions({
  language,
  context,
  marketData,
  topic,
  sentiment,
  routeCatalog = [],
  fieldCatalog = [],
  buttonCatalog = [],
}) {
  const safeContext = compactContext(context);

  return [
    "You are a CRM assistant running inside a trading CRM backend, and you can also drive the frontend UI on the user's behalf.",
    "Answer in the same language as the user when practical.",
    "Use the provided CRM context as the source of truth for account-specific facts.",
    "If CRM data is missing for a fact, say you do not see it in the backend context.",
    "If market forecast data is provided, use it for forex or crypto questions.",
    "Do not pretend to have live market data unless it is present in the provided market context.",
    "Keep answers concise and directly useful.",
    "If sentiment metadata shows frustration, urgency, or confusion, adapt your tone accordingly without sounding theatrical.",
    "You must respond with ONLY a single raw JSON object, no markdown fences, no commentary before or after it.",
    "JSON shape: { \"reply\": string, \"navigateRoute\": string|null, \"actions\": Array<{ \"type\": \"fill\"|\"select\"|\"click\", \"field\"?: string, \"target\"?: string, \"value\"?: string }> }.",
    "\"reply\" is the natural-language answer shown and spoken to the user. Never put JSON or code in it.",
    "\"navigateRoute\" must be exactly one of the allowed route paths below, or null if the user is not asking to open a page.",
    "\"actions\" lets you fill form fields, select options, or click buttons on the CRM page the user is currently on or navigating to. Use \"field\" for fill/select actions and \"target\" for click actions.",
    "Only use field names from the allowed field list and button names from the allowed button list below. If the user's request does not map to an allowed identifier, omit that action rather than inventing a new name.",
    "Return an empty actions array when no UI action is needed.",
    `Allowed routes: ${JSON.stringify(routeCatalog)}.`,
    `Allowed fill/select field names: ${JSON.stringify(fieldCatalog)}.`,
    `Allowed click button names: ${JSON.stringify(buttonCatalog)}.`,
    `Detected topic: ${topic || "unknown"}.`,
    `Assistant language: ${language || "en-IN"}.`,
    `User sentiment: ${sentiment ? JSON.stringify(sentiment) : "none"}.`,
    `CRM context: ${JSON.stringify(safeContext)}.`,
    `Market context: ${marketData ? JSON.stringify(marketData) : "none"}.`,
  ].join("\n");
}

function extractJsonObject(text) {
  if (!text || typeof text !== "string") {
    return null;
  }

  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    // fall through to brace extraction
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  try {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  } catch (error) {
    return null;
  }
}

function sanitizeActionValue(value) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).trim().slice(0, 200);
}

function validateAssistantIntent(parsed, { routeCatalog = [], fieldCatalog = [], buttonCatalog = [] }) {
  if (!parsed || typeof parsed !== "object") {
    return { reply: "", navigation: null, actions: [] };
  }

  const allowedRoutes = new Set(routeCatalog.map((entry) => entry.route));
  const allowedFields = new Set(fieldCatalog);
  const allowedButtons = new Set(buttonCatalog);

  const reply = typeof parsed.reply === "string" ? parsed.reply.trim() : "";

  let navigation = null;
  if (typeof parsed.navigateRoute === "string" && allowedRoutes.has(parsed.navigateRoute)) {
    const routeEntry = routeCatalog.find((entry) => entry.route === parsed.navigateRoute);
    navigation = { route: parsed.navigateRoute, label: routeEntry?.label || parsed.navigateRoute };
  }

  const actions = Array.isArray(parsed.actions)
    ? parsed.actions
        .map((action) => {
          if (!action || typeof action !== "object") {
            return null;
          }

          if (action.type === "fill" || action.type === "select") {
            if (typeof action.field !== "string" || !allowedFields.has(action.field)) {
              return null;
            }
            return {
              type: action.type,
              field: action.field,
              value: sanitizeActionValue(action.value),
            };
          }

          if (action.type === "click") {
            if (typeof action.target !== "string" || !allowedButtons.has(action.target)) {
              return null;
            }
            return { type: "click", target: action.target };
          }

          return null;
        })
        .filter(Boolean)
        .slice(0, 6)
    : [];

  return { reply, navigation, actions };
}

function extractResponseText(payload) {
  if (payload?.output_text && typeof payload.output_text === "string") {
    return payload.output_text.trim();
  }

  if (!Array.isArray(payload?.output)) {
    return "";
  }

  const chunks = [];

  for (const item of payload.output) {
    if (!Array.isArray(item?.content)) {
      continue;
    }

    for (const contentItem of item.content) {
      if (typeof contentItem?.text === "string" && contentItem.text.trim()) {
        chunks.push(contentItem.text.trim());
      }
    }
  }

  return chunks.join("\n").trim();
}

function sanitizeAssistantReply(text) {
  if (!text || typeof text !== "string") {
    return "";
  }

  const normalized = text.replace(/\r\n/g, "\n").trim();
  const lines = normalized.split("\n");
  const cleanedLines = [];
  let skippingMetaBlock = true;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      if (!skippingMetaBlock) {
        cleanedLines.push("");
      }
      continue;
    }

    const isMetaLine =
      /^(the user asks|user asks|the user wants|user wants)\b/i.test(line) ||
      /^(we have|we do not have|we can|we cannot)\b/i.test(line) ||
      /^according to instructions\b/i.test(line) ||
      /^keep concise\b/i.test(line) ||
      /^do not pretend\b/i.test(line) ||
      /^so we cannot\b/i.test(line);

    if (skippingMetaBlock && isMetaLine) {
      continue;
    }

    skippingMetaBlock = false;
    cleanedLines.push(rawLine);
  }

  return cleanedLines.join("\n").trim();
}

async function generateAssistantReply({
  message,
  language,
  history = [],
  context,
  navigation,
  marketData,
  topic,
  sentiment,
}) {
  if (!isOpenAIConfigured()) {
    const error = new Error("AI assistant provider is not configured in backend.");
    error.code = "AI_NOT_CONFIGURED";
    throw error;
  }

  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: DEFAULT_OPENAI_MODEL,
      instructions: buildInstructions({
        language,
        context,
        navigation,
        marketData,
        topic,
        sentiment,
      }),
      input: [
        ...history.slice(-8).map((entry) => ({
          role: entry?.role === "assistant" ? "assistant" : "user",
          content: entry?.text || "",
        })),
        {
          role: "user",
          content: message,
        },
      ],
      max_output_tokens: 500,
    }),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const messageText =
      payload?.error?.message ||
      payload?.message ||
      "AI assistant request failed.";
    const error = new Error(messageText);
    error.statusCode = response.status;
    throw error;
  }

  const replyText = sanitizeAssistantReply(extractResponseText(payload));

  if (!replyText) {
    throw new Error("AI assistant returned an empty response.");
  }

  return {
    reply: replyText,
    model: payload.model || DEFAULT_OPENAI_MODEL,
    responseId: payload.id || null,
  };
}

async function generateAssistantIntent({
  message,
  language,
  history = [],
  context,
  marketData,
  topic,
  sentiment,
  routeCatalog = [],
  fieldCatalog = [],
  buttonCatalog = [],
}) {
  if (!isOpenAIConfigured()) {
    const error = new Error("AI assistant provider is not configured in backend.");
    error.code = "AI_NOT_CONFIGURED";
    throw error;
  }

  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: DEFAULT_OPENAI_MODEL,
      instructions: buildIntentInstructions({
        language,
        context,
        marketData,
        topic,
        sentiment,
        routeCatalog,
        fieldCatalog,
        buttonCatalog,
      }),
      input: [
        ...history.slice(-8).map((entry) => ({
          role: entry?.role === "assistant" ? "assistant" : "user",
          content: entry?.text || "",
        })),
        {
          role: "user",
          content: message,
        },
      ],
      max_output_tokens: 600,
    }),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const messageText =
      payload?.error?.message ||
      payload?.message ||
      "AI assistant request failed.";
    const error = new Error(messageText);
    error.statusCode = response.status;
    throw error;
  }

  const rawText = extractResponseText(payload);
  const parsed = extractJsonObject(rawText);
  const { reply, navigation, actions } = validateAssistantIntent(parsed, {
    routeCatalog,
    fieldCatalog,
    buttonCatalog,
  });

  const replyText = sanitizeAssistantReply(reply || (parsed ? "" : rawText));

  if (!replyText) {
    throw new Error("AI assistant returned an empty response.");
  }

  return {
    reply: replyText,
    navigation,
    actions,
    model: payload.model || DEFAULT_OPENAI_MODEL,
    responseId: payload.id || null,
  };
}

module.exports = {
  generateAssistantReply,
  generateAssistantIntent,
  isOpenAIConfigured,
};
