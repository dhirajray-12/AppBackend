const normalizeUploadPath = (value) => {
  if (!value || typeof value !== "string") {
    return value;
  }

  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return trimmedValue;
  }

  if (/^https?:\/\//i.test(trimmedValue)) {
    return trimmedValue;
  }

  const normalizedValue = trimmedValue.replace(/\\/g, "/");
  const uploadsMatch = normalizedValue.match(/(?:^|\/)(uploads\/.*)$/i);

  if (uploadsMatch?.[1]) {
    return `/${uploadsMatch[1]}`;
  }

  return normalizedValue.startsWith("/") ? normalizedValue : `/${normalizedValue}`;
};

const buildPaymentMethodDisplayName = (paymentMethod) => {
  if (paymentMethod.type === "Bank Account") {
    return `${paymentMethod.bankName || ""}-a/c:- ${paymentMethod.accountNumber || ""}`;
  }

  if (paymentMethod.type === "Crypto Wallet") {
    return `${paymentMethod.walletName || ""}-${paymentMethod.walletAddress || ""}`;
  }

  return paymentMethod.accountHolderName || paymentMethod.type;
};

const normalizePaymentMethodAssetFields = (paymentMethod) => {
  if (!paymentMethod) {
    return paymentMethod;
  }

  return {
    ...paymentMethod,
    qrCode: normalizeUploadPath(paymentMethod.qrCode),
    displayName: buildPaymentMethodDisplayName(paymentMethod),
  };
};

const normalizeDepositAssetFields = (deposit) => {
  if (!deposit) {
    return deposit;
  }

  return {
    ...deposit,
    proofOfPayment: normalizeUploadPath(deposit.proofOfPayment),
  };
};

const normalizeClientDocumentFields = (client) => {
  if (!client) {
    return client;
  }

  return {
    ...client,
    idDocument: normalizeUploadPath(client.idDocument) || "",
    address1Document: normalizeUploadPath(client.address1Document) || "",
    address2Document: normalizeUploadPath(client.address2Document) || "",
  };
};

const normalizeAttachmentAssetFields = (attachment) => {
  if (!attachment) {
    return attachment;
  }

  return {
    ...attachment,
    filePath: normalizeUploadPath(attachment.filePath),
  };
};

const normalizeTicketAssetFields = (ticket) => {
  if (!ticket) {
    return ticket;
  }

  return {
    ...ticket,
    attachments: Array.isArray(ticket.attachments)
      ? ticket.attachments.map(normalizeAttachmentAssetFields)
      : ticket.attachments,
    messages: Array.isArray(ticket.messages)
      ? ticket.messages.map((message) => ({
          ...message,
          attachments: Array.isArray(message.attachments)
            ? message.attachments.map(normalizeAttachmentAssetFields)
            : message.attachments,
        }))
      : ticket.messages,
  };
};

module.exports = {
  normalizeUploadPath,
  buildPaymentMethodDisplayName,
  normalizePaymentMethodAssetFields,
  normalizeDepositAssetFields,
  normalizeClientDocumentFields,
  normalizeAttachmentAssetFields,
  normalizeTicketAssetFields,
};
