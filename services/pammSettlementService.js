// Backend/services/pammSettlementService.js
// Core PAMM money-movement + valuation engine.
//
// A PAMM fund is one client's real MT5 Account acting as a pool. Investors
// move real money in/out of that pool (via the same MT5 manager-API
// deposit/withdraw calls the Transfer/Withdrawal features already use), and
// their stake is tracked as *units* of the fund so pooled profit/loss is
// split fairly (NAV-per-unit accounting, like a mutual fund). The manager
// keeps trading the pooled account through the existing Trade View /
// trading terminal — this file never places or mirrors trades, it only
// moves cash in/out and keeps the unit ledger honest.
//
// A manager's own capital in the pool is represented as a normal
// PammInvestment too (investor === manager, account === the fund's own
// pooled account) so it isn't invisibly diluted or credited by investor
// activity — see controllers/admin/pammController.js#createFund. The
// manager's own position is excluded from fee assessment in settleFund
// (a manager doesn't owe themselves a management/performance fee).
const Pamm = require("../models/Pamm");
const PammInvestment = require("../models/PammInvestment");
const PammTransaction = require("../models/PammTransaction");
const Account = require("../models/client/Account");
const { metaApi } = require("../API/metaApi");
require("dotenv").config();

const MANAGER_INDEX =
  process.env.MANAGER_INDEX || process.env.Manager_Index || 1;
const API_TIMEOUT = 30000;

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Same MT5 manager-API calls used by transferController.js / withdrawalController.js.
async function makeWithdrawal(mt5Account, amount, comment = "PAMM withdrawal") {
  const response = await metaApi.get("/MakeWithdrawBalance", {
    params: {
      Manager_Index: MANAGER_INDEX,
      MT5Account: mt5Account,
      Amount: amount,
      Comment: comment,
    },
    timeout: API_TIMEOUT,
  });

  if (response.data.error || !response.data.Result) {
    throw new Error(response.data.message || "MT5 withdrawal failed");
  }

  return response.data;
}

async function makeDeposit(mt5Account, amount, comment = "PAMM deposit") {
  const response = await metaApi.get("/MakeDepositBalance", {
    params: {
      Manager_Index: MANAGER_INDEX,
      MT5Account: mt5Account,
      Amount: amount,
      Comment: comment,
    },
    timeout: API_TIMEOUT,
  });

  if (response.data.error || !response.data.Result) {
    throw new Error(response.data.message || "MT5 deposit failed");
  }

  return response.data;
}

// Executes an admin-approved investment request: real MT5 money movement
// (investor account -> fund's pool account) followed by unit issuance.
async function executeInvestment(transactionId, adminId) {
  const tx = await PammTransaction.findById(transactionId);
  if (!tx) throw new Error("Investment request not found");
  if (tx.type !== "investment") throw new Error("Not an investment request");
  if (tx.status !== "pending") throw new Error("Request has already been processed");

  const [pamm, investorAccount] = await Promise.all([
    Pamm.findById(tx.pamm),
    Account.findById(tx.account),
  ]);
  if (!pamm) throw new Error("Fund not found");
  if (pamm.status !== "active") throw new Error("Fund is not active");
  if (!investorAccount) throw new Error("Investor account not found");

  if (investorAccount.balance < tx.amount) {
    tx.status = "rejected";
    tx.remarks = "Insufficient balance in investor account";
    tx.processedBy = adminId;
    tx.processedAt = new Date();
    await tx.save();
    return { tx, rejected: true };
  }

  const managerAccount = await Account.findById(pamm.account);
  if (!managerAccount) throw new Error("Fund's pooled account not found");

  const withdrawalResult = await makeWithdrawal(
    investorAccount.mt5Account,
    tx.amount,
    `PAMM investment into ${pamm.name}`,
  );
  const depositResult = await makeDeposit(
    managerAccount.mt5Account,
    tx.amount,
    `PAMM investment from ${investorAccount.mt5Account}`,
  );

  investorAccount.balance = withdrawalResult.Balance;
  investorAccount.equity = withdrawalResult.Equity;
  managerAccount.balance = depositResult.Balance;
  managerAccount.equity = depositResult.Equity;
  await Promise.all([investorAccount.save(), managerAccount.save()]);

  const navPerUnit = pamm.navPerUnit > 0 ? pamm.navPerUnit : 100;
  const units = tx.amount / navPerUnit;

  let investment = await PammInvestment.findOne({
    pamm: pamm._id,
    investor: tx.investor,
    account: tx.account,
    status: "active",
  });

  let isNewPosition = false;
  if (investment) {
    const combinedUnits = investment.units + units;
    // Weighted-average the high-water mark across the old and new stake so
    // a top-up doesn't let profit already earned on the old stake dodge
    // the performance fee, nor unfairly charge fee on the fresh money.
    investment.hwmNav =
      (investment.units * investment.hwmNav + units * navPerUnit) /
      combinedUnits;
    investment.units = combinedUnits;
    investment.principalInvested += tx.amount;
    await investment.save();
  } else {
    isNewPosition = true;
    investment = await PammInvestment.create({
      pamm: pamm._id,
      investor: tx.investor,
      account: tx.account,
      units,
      principalInvested: tx.amount,
      hwmNav: navPerUnit,
    });
  }

  pamm.totalUnits += units;
  if (isNewPosition) pamm.totalInvestors += 1;
  pamm.aum = round2(pamm.navPerUnit * pamm.totalUnits);
  await pamm.save();

  tx.status = "completed";
  tx.units = units;
  tx.navAtTransaction = navPerUnit;
  tx.investment = investment._id;
  tx.processedBy = adminId;
  tx.processedAt = new Date();
  tx.mt5Ticket = withdrawalResult.Ticket ? String(withdrawalResult.Ticket) : null;
  await tx.save();

  return { tx, pamm, investment, rejected: false };
}

// Executes an admin-approved redemption request: real MT5 money movement
// (fund's pool account -> investor's own account) at the *current* NAV
// (not the NAV when the request was submitted), followed by burning units.
async function executeRedemption(transactionId, adminId) {
  const tx = await PammTransaction.findById(transactionId);
  if (!tx) throw new Error("Redemption request not found");
  if (tx.type !== "redemption") throw new Error("Not a redemption request");
  if (tx.status !== "pending") throw new Error("Request has already been processed");

  const [pamm, investment] = await Promise.all([
    Pamm.findById(tx.pamm),
    PammInvestment.findById(tx.investment),
  ]);
  if (!pamm) throw new Error("Fund not found");
  if (!investment || investment.status !== "active") {
    throw new Error("Investment position not found or already closed");
  }

  if (tx.units > investment.units + 1e-9) {
    tx.status = "rejected";
    tx.remarks = "Requested units exceed the current holding";
    tx.processedBy = adminId;
    tx.processedAt = new Date();
    await tx.save();
    return { tx, rejected: true };
  }

  const [managerAccount, investorAccount] = await Promise.all([
    Account.findById(pamm.account),
    Account.findById(tx.account),
  ]);
  if (!managerAccount || !investorAccount) {
    throw new Error("Linked account not found");
  }

  const navPerUnit = pamm.navPerUnit > 0 ? pamm.navPerUnit : 100;
  const cashAmount = round2(tx.units * navPerUnit);

  if (cashAmount > 0 && managerAccount.balance < cashAmount) {
    throw new Error(
      "The fund's pooled account has insufficient balance to pay out this redemption right now",
    );
  }

  let withdrawalResult = null;
  let depositResult = null;
  if (cashAmount > 0) {
    withdrawalResult = await makeWithdrawal(
      managerAccount.mt5Account,
      cashAmount,
      `PAMM redemption for ${investorAccount.mt5Account}`,
    );
    depositResult = await makeDeposit(
      investorAccount.mt5Account,
      cashAmount,
      `PAMM redemption from ${pamm.name}`,
    );

    managerAccount.balance = withdrawalResult.Balance;
    managerAccount.equity = withdrawalResult.Equity;
    investorAccount.balance = depositResult.Balance;
    investorAccount.equity = depositResult.Equity;
    await Promise.all([managerAccount.save(), investorAccount.save()]);
  }

  investment.units = Math.max(0, investment.units - tx.units);
  investment.principalRedeemed += cashAmount;
  let closedPosition = false;
  if (investment.units <= 1e-6) {
    investment.units = 0;
    investment.status = "closed";
    investment.closedAt = new Date();
    closedPosition = true;
  }
  await investment.save();

  pamm.totalUnits = Math.max(0, pamm.totalUnits - tx.units);
  if (closedPosition) pamm.totalInvestors = Math.max(0, pamm.totalInvestors - 1);
  pamm.aum = round2(pamm.navPerUnit * pamm.totalUnits);
  await pamm.save();

  tx.status = "completed";
  tx.amount = cashAmount;
  tx.navAtTransaction = navPerUnit;
  tx.processedBy = adminId;
  tx.processedAt = new Date();
  tx.mt5Ticket = withdrawalResult?.Ticket ? String(withdrawalResult.Ticket) : null;
  await tx.save();

  return { tx, pamm, investment, rejected: false };
}

// Revalues a fund from its pool account's real (continuously-synced)
// equity, applies management + performance fees per investor, and rolls
// the fee total into a single MT5 balance movement to the manager. Safe to
// call repeatedly (manual admin trigger or the daily cron) — a fund with no
// active investors, or whose account can't be found, is a no-op.
async function settleFund(pammId, { manual = false, io = null, notificationTriggers = null } = {}) {
  const pamm = await Pamm.findById(pammId);
  if (!pamm) throw new Error("Fund not found");
  if (pamm.status !== "active") {
    return { skipped: true, reason: "Fund is not active" };
  }

  const managerAccount = await Account.findById(pamm.account);
  if (!managerAccount) {
    return { skipped: true, reason: "Fund's pooled account not found" };
  }

  const activeInvestments = await PammInvestment.find({
    pamm: pamm._id,
    status: "active",
  });
  const totalUnitsBefore = activeInvestments.reduce((sum, inv) => sum + inv.units, 0);

  const now = new Date();

  if (totalUnitsBefore <= 0) {
    pamm.totalUnits = 0;
    pamm.aum = 0;
    pamm.lastSettlementAt = now;
    await pamm.save();
    return { skipped: true, reason: "No active investors" };
  }

  // The pool account's real, continuously-synced equity IS the fund's AUM.
  const currentAUM = managerAccount.equity || managerAccount.balance || 0;
  const newNav = currentAUM / totalUnitsBefore;

  const daysElapsed = Math.max(
    0,
    (now.getTime() - new Date(pamm.lastSettlementAt).getTime()) / (1000 * 60 * 60 * 24),
  );
  const mgmtFeeFraction = (pamm.managementFeePercent / 100) * (daysElapsed / 365);

  let totalFeeCash = 0;
  const feeTransactionDocs = [];

  for (const investment of activeInvestments) {
    try {
      // A manager doesn't pay fees on their own capital in their own fund.
      if (String(investment.investor) === String(pamm.manager)) {
        if (newNav > investment.hwmNav) {
          investment.hwmNav = newNav;
          await investment.save();
        }
        continue;
      }

      const valueBefore = investment.units * newNav;
      const managementFee = mgmtFeeFraction > 0 ? valueBefore * mgmtFeeFraction : 0;

      const profitPerUnit = Math.max(0, newNav - investment.hwmNav);
      const performanceFeeCash =
        profitPerUnit > 0
          ? profitPerUnit * investment.units * (pamm.performanceFeePercent / 100)
          : 0;

      const feeCashForInvestor = round2(managementFee + performanceFeeCash);

      if (newNav > investment.hwmNav) investment.hwmNav = newNav;

      if (feeCashForInvestor <= 0) {
        await investment.save();
        continue;
      }

      const feeUnits = feeCashForInvestor / newNav;
      investment.units = Math.max(0, investment.units - feeUnits);
      investment.totalFeesPaid += feeCashForInvestor;
      await investment.save();

      totalFeeCash += feeCashForInvestor;

      feeTransactionDocs.push({
        pamm: pamm._id,
        investment: investment._id,
        investor: investment.investor,
        account: investment.account,
        type: performanceFeeCash > managementFee ? "performance_fee" : "management_fee",
        status: "completed",
        amount: feeCashForInvestor,
        units: -feeUnits,
        navAtTransaction: newNav,
        remarks: `Management fee: $${managementFee.toFixed(2)}, Performance fee: $${performanceFeeCash.toFixed(2)}`,
        processedAt: now,
      });
    } catch (investorError) {
      // One investor's fee calc failing shouldn't abort the whole run.
      console.error(
        `PAMM settlement: failed for investment ${investment._id}:`,
        investorError.message,
      );
    }
  }

  if (feeTransactionDocs.length > 0) {
    await PammTransaction.insertMany(feeTransactionDocs);
  }

  const totalUnitsAfter = activeInvestments.reduce((sum, inv) => sum + inv.units, 0);
  pamm.totalUnits = totalUnitsAfter;
  pamm.navPerUnit = newNav;
  pamm.aum = round2(newNav * totalUnitsAfter);
  pamm.lastSettlementAt = now;
  await pamm.save();

  // Roll the collected fees into a single real MT5 movement so the
  // manager's own account balance reflects the fees they just earned as a
  // distinct, auditable transaction rather than only a unit-ledger entry.
  let creditedFee = 0;
  if (totalFeeCash > 0) {
    try {
      const roundedFee = round2(totalFeeCash);
      const withdrawalResult = await makeWithdrawal(
        managerAccount.mt5Account,
        roundedFee,
        `PAMM fee settlement for ${pamm.name}`,
      );
      const depositResult = await makeDeposit(
        managerAccount.mt5Account,
        roundedFee,
        `PAMM fee credit for ${pamm.name}`,
      );

      managerAccount.balance = depositResult.Balance;
      managerAccount.equity = depositResult.Equity;
      await managerAccount.save();
      creditedFee = roundedFee;

      await PammTransaction.create({
        pamm: pamm._id,
        investor: pamm.manager,
        type: "settlement",
        status: "completed",
        amount: roundedFee,
        navAtTransaction: newNav,
        remarks: `Fees credited to manager for this settlement run (${manual ? "manual" : "scheduled"})`,
        mt5Ticket: withdrawalResult.Ticket ? String(withdrawalResult.Ticket) : null,
        processedAt: now,
      });
    } catch (feeTransferError) {
      console.error(
        `PAMM settlement: fee credit to manager failed for fund ${pamm._id}:`,
        feeTransferError.message,
      );
    }
  }

  if (notificationTriggers && creditedFee > 0) {
    notificationTriggers
      .handlePammSettlement(pamm.toObject(), creditedFee)
      .catch(() => {});
  }
  if (io && io.emitPammUpdate) {
    io.emitPammUpdate(pamm.toObject(), "settled");
  }

  return {
    pamm,
    newNav,
    totalFeeCash: creditedFee,
    investorsSettled: activeInvestments.length,
  };
}

// Settles every active fund whose management-fee period has elapsed since
// its last settlement. Used by the daily cron; a manual admin trigger calls
// settleFund() directly instead, regardless of the due window.
const FREQUENCY_DAYS = { weekly: 7, monthly: 30, quarterly: 90 };

async function settleAllDueFunds({ io = null, notificationTriggers = null } = {}) {
  const funds = await Pamm.find({ status: "active" }).select(
    "_id managementFeeFrequency lastSettlementAt",
  );

  const now = Date.now();
  const results = [];

  for (const fund of funds) {
    const dueDays = FREQUENCY_DAYS[fund.managementFeeFrequency] || 30;
    const elapsedDays =
      (now - new Date(fund.lastSettlementAt).getTime()) / (1000 * 60 * 60 * 24);

    if (elapsedDays < dueDays) continue;

    try {
      const result = await settleFund(fund._id, { manual: false, io, notificationTriggers });
      results.push({ pammId: fund._id, ...result });
    } catch (error) {
      console.error(`PAMM settlement: settleAllDueFunds failed for fund ${fund._id}:`, error.message);
      results.push({ pammId: fund._id, error: error.message });
    }
  }

  return results;
}

module.exports = {
  makeWithdrawal,
  makeDeposit,
  executeInvestment,
  executeRedemption,
  settleFund,
  settleAllDueFunds,
  round2,
};
