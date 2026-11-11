// Shared permission catalogue for the Subadmin feature.
// IMPORTANT: This file is duplicated verbatim at
// src/constants/permissions.ts in the frontend repo. Keep both in sync manually.

const PERMISSIONS = {
  DASHBOARD_VIEW: "dashboard.view",

  CLIENTS_VIEW: "clients.view",
  CLIENTS_EDIT: "clients.edit",
  CLIENTS_EXPORT: "clients.export",
  CLIENTS_SUSPEND: "clients.suspend",

  KYC_VIEW: "kyc.view",
  KYC_APPROVE: "kyc.approve",

  DEPOSITS_VIEW: "deposits.view",
  DEPOSITS_EDIT: "deposits.edit",
  DEPOSITS_APPROVE: "deposits.approve",

  WITHDRAWALS_VIEW: "withdrawals.view",
  WITHDRAWALS_EDIT: "withdrawals.edit",
  WITHDRAWALS_APPROVE: "withdrawals.approve",

  PAYMENTS_VIEW: "payments.view",
  PAYMENTS_EDIT: "payments.edit",

  TRANSACTIONS_VIEW: "transactions.view",
  TRANSACTIONS_EXPORT: "transactions.export",

  EMAIL_LOGS_VIEW: "email_logs.view",

  SUPPORT_VIEW: "support.view",
  SUPPORT_EDIT: "support.edit",

  IB_PARTNERS_VIEW: "ib_partners.view",
  IB_PARTNERS_EDIT: "ib_partners.edit",

  IB_CONFIGURATION_VIEW: "ib_configuration.view",
  IB_CONFIGURATION_EDIT: "ib_configuration.edit",

  IB_WITHDRAWAL_VIEW: "ib_withdrawal.view",
  IB_WITHDRAWAL_APPROVE: "ib_withdrawal.approve",

  COPY_COPIER_VIEW: "copy_copier.view",
  COPY_COPIER_EDIT: "copy_copier.edit",

  COPY_MASTERS_VIEW: "copy_masters.view",
  COPY_MASTERS_EDIT: "copy_masters.edit",

  COPY_RATING_VIEW: "copy_rating.view",
  COPY_RATING_EDIT: "copy_rating.edit",

  REVENUE_ANALYTICS_VIEW: "revenue_analytics.view",
  REVENUE_ANALYTICS_EXPORT: "revenue_analytics.export",

  PAMM_VIEW: "pamm.view",
  PAMM_EDIT: "pamm.edit",
};

const ALL_PERMISSIONS = Object.values(PERMISSIONS);

const PERMISSION_GROUPS = [
  {
    key: "dashboard",
    label: "Dashboard",
    permissions: [PERMISSIONS.DASHBOARD_VIEW],
  },
  {
    key: "clients",
    label: "Clients",
    permissions: [
      PERMISSIONS.CLIENTS_VIEW,
      PERMISSIONS.CLIENTS_EDIT,
      PERMISSIONS.CLIENTS_EXPORT,
      PERMISSIONS.CLIENTS_SUSPEND,
    ],
  },
  {
    key: "kyc",
    label: "KYC Verification",
    permissions: [PERMISSIONS.KYC_VIEW, PERMISSIONS.KYC_APPROVE],
  },
  {
    key: "deposits",
    label: "Deposits",
    permissions: [
      PERMISSIONS.DEPOSITS_VIEW,
      PERMISSIONS.DEPOSITS_EDIT,
      PERMISSIONS.DEPOSITS_APPROVE,
    ],
  },
  {
    key: "withdrawals",
    label: "Withdrawals",
    permissions: [
      PERMISSIONS.WITHDRAWALS_VIEW,
      PERMISSIONS.WITHDRAWALS_EDIT,
      PERMISSIONS.WITHDRAWALS_APPROVE,
    ],
  },
  {
    key: "payments",
    label: "Add Payments",
    permissions: [PERMISSIONS.PAYMENTS_VIEW, PERMISSIONS.PAYMENTS_EDIT],
  },
  {
    key: "transactions",
    label: "Transactions",
    permissions: [
      PERMISSIONS.TRANSACTIONS_VIEW,
      PERMISSIONS.TRANSACTIONS_EXPORT,
    ],
  },
  {
    key: "email_logs",
    label: "Email Logs",
    permissions: [PERMISSIONS.EMAIL_LOGS_VIEW],
  },
  {
    key: "support",
    label: "Support",
    permissions: [PERMISSIONS.SUPPORT_VIEW, PERMISSIONS.SUPPORT_EDIT],
  },
  {
    key: "ib_partners",
    label: "IB Partners",
    permissions: [PERMISSIONS.IB_PARTNERS_VIEW, PERMISSIONS.IB_PARTNERS_EDIT],
  },
  {
    key: "ib_configuration",
    label: "IB Configuration",
    permissions: [
      PERMISSIONS.IB_CONFIGURATION_VIEW,
      PERMISSIONS.IB_CONFIGURATION_EDIT,
    ],
  },
  {
    key: "ib_withdrawal",
    label: "IB Withdrawal",
    permissions: [
      PERMISSIONS.IB_WITHDRAWAL_VIEW,
      PERMISSIONS.IB_WITHDRAWAL_APPROVE,
    ],
  },
  {
    key: "copy_trading",
    label: "Copy Trading",
    permissions: [
      PERMISSIONS.COPY_COPIER_VIEW,
      PERMISSIONS.COPY_COPIER_EDIT,
      PERMISSIONS.COPY_MASTERS_VIEW,
      PERMISSIONS.COPY_MASTERS_EDIT,
      PERMISSIONS.COPY_RATING_VIEW,
      PERMISSIONS.COPY_RATING_EDIT,
    ],
  },
  {
    key: "revenue_analytics",
    label: "Revenue Analytics",
    permissions: [
      PERMISSIONS.REVENUE_ANALYTICS_VIEW,
      PERMISSIONS.REVENUE_ANALYTICS_EXPORT,
    ],
  },
  {
    key: "pamm",
    label: "PAMM",
    permissions: [PERMISSIONS.PAMM_VIEW, PERMISSIONS.PAMM_EDIT],
  },
];

module.exports = { PERMISSIONS, ALL_PERMISSIONS, PERMISSION_GROUPS };
