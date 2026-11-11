function normalizeText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s!?]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const FRUSTRATION_HINTS = [
  "not working",
  "broken",
  "issue",
  "error",
  "failed",
  "fail",
  "problem",
  "stuck",
  "annoying",
  "frustrated",
  "frustrating",
  "angry",
  "wtf",
  "urgent issue",
  "doesn't work",
  "cant",
  "can't",
  "wrong",
  "bug",
];

const URGENCY_HINTS = [
  "urgent",
  "asap",
  "immediately",
  "right now",
  "now",
  "quickly",
  "soon",
  "today",
];

const CONFUSION_HINTS = [
  "confused",
  "don't understand",
  "dont understand",
  "not sure",
  "how do i",
  "how can i",
  "what does this mean",
  "why",
  "help me understand",
];

const POSITIVE_HINTS = [
  "great",
  "good",
  "nice",
  "thanks",
  "thank you",
  "perfect",
  "awesome",
  "love",
];

function countMatches(text, hints) {
  return hints.reduce(
    (total, hint) => total + (text.includes(hint) ? 1 : 0),
    0,
  );
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundTo(value, digits = 2) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return 0;
  }

  return Number(amount.toFixed(digits));
}

function deriveLabel({ sentimentScore, frustrationScore, urgencyScore, confusionScore }) {
  if (frustrationScore >= 0.55 || sentimentScore <= -0.45) {
    return "frustrated";
  }

  if (urgencyScore >= 0.6) {
    return "urgent";
  }

  if (confusionScore >= 0.45) {
    return "confused";
  }

  if (sentimentScore >= 0.35) {
    return "positive";
  }

  return "neutral";
}

function getRecommendedTone(label) {
  switch (label) {
    case "frustrated":
      return "calm and direct";
    case "urgent":
      return "fast and concise";
    case "confused":
      return "clear and step-by-step";
    case "positive":
      return "brief and upbeat";
    default:
      return "neutral and helpful";
  }
}

function localizeLead(language, label) {
  const dictionary = {
    frustrated: {
      "en-IN": "I can see this is frustrating. I will keep it direct.",
      "hi-IN": "Mujhe lag raha hai yeh frustrating hai. Main seedha answer deta hoon.",
      "tr-TR": "Bunun can sıkıcı olduğunu görüyorum. Kısa ve net ilerleyeceğim.",
      "ar-SA": "أرى أن هذا مزعج. سأبقي الرد مباشرًا.",
      "ru-RU": "Похоже, это раздражает. Отвечу прямо и коротко.",
    },
    urgent: {
      "en-IN": "This sounds time-sensitive. Here is the quickest path.",
      "hi-IN": "Yeh urgent lag raha hai. Yeh sabse tez path hai.",
      "tr-TR": "Bu acil görünüyor. En hızlı yol şu.",
      "ar-SA": "يبدو أن الأمر عاجل. هذا أسرع مسار.",
      "ru-RU": "Похоже, это срочно. Вот самый быстрый путь.",
    },
    confused: {
      "en-IN": "I will keep this simple and clear.",
      "hi-IN": "Main ise simple aur clear rakhta hoon.",
      "tr-TR": "Bunu basit ve net tutacağım.",
      "ar-SA": "سأجعل هذا بسيطًا وواضحًا.",
      "ru-RU": "Объясню это просто и понятно.",
    },
  };

  return dictionary[label]?.[language] || dictionary[label]?.["en-IN"] || "";
}

function prefixReplyWithSentiment(reply, sentiment, language) {
  if (!reply || !sentiment) {
    return reply;
  }

  if (!["frustrated", "urgent", "confused"].includes(sentiment.label)) {
    return reply;
  }

  const lead = localizeLead(language, sentiment.label);
  if (!lead) {
    return reply;
  }

  if (reply.startsWith(lead)) {
    return reply;
  }

  return `${lead} ${reply}`.trim();
}

function analyzeAssistantSentiment(message = "", history = []) {
  const normalizedMessage = normalizeText(message);
  const recentHistory = Array.isArray(history)
    ? history
        .slice(-4)
        .map((entry) => normalizeText(entry?.text || ""))
        .join(" ")
    : "";
  const combinedText = `${recentHistory} ${normalizedMessage}`.trim();
  const baseText = combinedText || normalizedMessage;

  const frustrationMatches = countMatches(baseText, FRUSTRATION_HINTS);
  const urgencyMatches = countMatches(baseText, URGENCY_HINTS);
  const confusionMatches = countMatches(baseText, CONFUSION_HINTS);
  const positiveMatches = countMatches(baseText, POSITIVE_HINTS);
  const exclamationBoost = (message.match(/!/g) || []).length >= 2 ? 0.12 : 0;
  const uppercaseBoost =
    message.length >= 6 && /[A-Z]{4,}/.test(message) ? 0.12 : 0;

  const sentimentScore = clamp(
    roundTo(
      positiveMatches * 0.22 -
        frustrationMatches * 0.28 -
        confusionMatches * 0.08,
      2,
    ),
    -1,
    1,
  );
  const frustrationScore = clamp(
    roundTo(frustrationMatches * 0.3 + exclamationBoost + uppercaseBoost, 2),
    0,
    1,
  );
  const urgencyScore = clamp(
    roundTo(urgencyMatches * 0.28 + exclamationBoost + uppercaseBoost, 2),
    0,
    1,
  );
  const confusionScore = clamp(
    roundTo(confusionMatches * 0.28, 2),
    0,
    1,
  );

  const label = deriveLabel({
    sentimentScore,
    frustrationScore,
    urgencyScore,
    confusionScore,
  });

  return {
    label,
    sentimentScore,
    frustrationScore,
    urgencyScore,
    confusionScore,
    recommendedTone: getRecommendedTone(label),
  };
}

module.exports = {
  analyzeAssistantSentiment,
  prefixReplyWithSentiment,
};
