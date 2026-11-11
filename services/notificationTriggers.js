// Backend/services/notificationTriggers.js
const NotificationService = require("./notificationService");

class NotificationTriggers {
  constructor(io) {
    this.notificationService = new NotificationService(io);
  }

  // 1. Account Created Notifications
  async handleAccountCreated(accountData) {
    try {
      console.log("Handling account created notification:", accountData);
      const {
        user,
        mt5Account,
        accountType,
        leverage,
        investor_pwd,
        master_pwd,
        platform,
        serverName,
      } = accountData;
      console.log("Handling account created notification for user:", user);

      // Notify the client
      await this.notificationService.createNotification({
        recipients: user,
        title: "🎉 New MT5 Account Created!",
        message: `Your new MT5 account ${mt5Account} has been successfully created and is ready for trading.`,
        type: "account_created",
        priority: "high",
        data: {
          mt5Account,
          accountType,
          leverage,
          platform: platform || "MT5", // ✅ NEW: Default value
          investorPassword: investor_pwd, // ✅ NEW: Guaranteed value
          masterPassword: master_pwd, // ✅ NEW: Guaranteed value
          serverName,
        },
        relatedModel: "Account",
        relatedId: accountData._id,
      });

      // Notify all admins
      const adminUsers = await this.notificationService.getAdminUsers();
      console.log("Admin users for account created notification:", adminUsers);
      if (adminUsers.length > 0) {
        await this.notificationService.createNotification({
          recipients: adminUsers.map((admin) => admin._id),
          title: "📊 New MT5 Account Created",
          message: `A new MT5 account ${mt5Account} has been created for client.`,
          type: "account_created",
          priority: "medium",
          data: {
            mt5Account,
            accountType,
            leverage,
            clientId: user,
            serverName,
          },
          relatedModel: "Account",
          relatedId: accountData._id,
        });
      }
    } catch (error) {
      console.error("Error handling account created notification:", error);
    }
  }

  // 2. Deposit Status Notifications
  async handleDepositStatusChange(depositData, previousStatus) {
    try {
      const { user, amount, status, paymentMethod, remarks } = depositData;

      // Extract payment method details - DYNAMIC & SCALABLE VERSION
      let paymentMethodName = "N/A";

      if (paymentMethod) {
        if (typeof paymentMethod === "string") {
          paymentMethodName = paymentMethod;
        } else if (paymentMethod.type) {
          // Configuration map for payment method details
          const detailFields = {
            "Bank Account": "bankName",
            "Crypto Wallet": "walletName",
            "Online Banking": null,
            Other: null,
          };

          // Get the base type
          paymentMethodName = paymentMethod.type;

          // Dynamically append details if the field exists
          const detailField = detailFields[paymentMethod.type];
          if (detailField && paymentMethod[detailField]) {
            paymentMethodName += ` - ${paymentMethod[detailField]}`;
          }
        }
      }

      // Notify the client about deposit status change
      const statusMessages = {
        Pending: "Your deposit request is being processed.",
        Approved:
          "Great news! Your deposit has been approved and funds have been added to your account.",
        Rejected:
          "Your deposit request has been rejected. Please contact support for more information.",
      };

      const statusIcons = {
        Pending: "⏳",
        Approved: "✅",
        Rejected: "❌",
      };

      await this.notificationService.createNotification({
        recipients: user,
        title: `${statusIcons[status]} Deposit ${status}`,
        message: statusMessages[status],
        type: "deposit_status",
        priority: status === "Rejected" ? "high" : "medium",
        data: {
          amount,
          status,
          paymentMethod: paymentMethodName,
          remarks,
          previousStatus,
        },
        relatedModel: "Deposit",
        relatedId: depositData._id,
      });

      // Notify admins when deposit is submitted (Pending status)
      if (status === "Pending" && previousStatus !== "Pending") {
        const adminUsers = await this.notificationService.getAdminUsers();
        console.log(
          "Admin users for deposit status change notification:",
          adminUsers
        );
        if (adminUsers.length > 0) {
          await this.notificationService.createNotification({
            recipients: adminUsers.map((admin) => admin._id),
            title: "💰 New Deposit Request",
            message: `A new deposit request of $${amount} has been submitted and requires approval.`,
            type: "deposit_status",
            priority: "medium",
            data: {
              amount,
              status,
              paymentMethod: paymentMethodName,
              clientId: user,
            },
            relatedModel: "Deposit",
            relatedId: depositData._id,
          });
        }
      }
    } catch (error) {
      console.error("Error handling deposit status notification:", error);
    }
  }

  // 3. Withdrawal Status Notifications
  async handleWithdrawalStatusChange(withdrawalData, previousStatus) {
    try {
      const { user, amount, status, remarks } = withdrawalData;

      // Realtime `withdrawal_updated` emission is handled by the caller
      // (each controller calls io.emitWithdrawalUpdate itself, with the
      // correct previousStatus and alongside its cache invalidation). Doing
      // it here too used to double-emit the event to the client.

      const statusMessages = {
        Pending: "Your withdrawal request is being processed.",
        Approved:
          "Your withdrawal has been approved and will be processed shortly.",
        Rejected:
          "Your withdrawal request has been rejected. Please contact support for more information.",
      };

      const statusIcons = {
        Pending: "⏳",
        Approved: "✅",
        Rejected: "❌",
      };

      // Notify the client
      await this.notificationService.createNotification({
        recipients: user,
        title: `${statusIcons[status]} Withdrawal ${status}`,
        message: statusMessages[status],
        type: "withdrawal_status",
        priority: status === "Rejected" ? "high" : "medium",
        data: {
          amount,
          status,
          remarks,
          previousStatus,
        },
        relatedModel: "Withdrawal",
        relatedId: withdrawalData._id,
      });

      // Notify admins when withdrawal is submitted
      if (status === "Pending" && previousStatus !== "Pending") {
        const adminUsers = await this.notificationService.getAdminUsers();
        if (adminUsers.length > 0) {
          await this.notificationService.createNotification({
            recipients: adminUsers.map((admin) => admin._id),
            title: "💸 New Withdrawal Request",
            message: `A new withdrawal request of $${amount} has been submitted and requires approval.`,
            type: "withdrawal_status",
            priority: "medium",
            data: {
              amount,
              status,
              clientId: user,
            },
            relatedModel: "Withdrawal",
            relatedId: withdrawalData._id,
          });
        }
      }
    } catch (error) {
      console.error("Error handling withdrawal status notification:", error);
    }
  }

  // 4. Transfer Success Notifications
  async handleTransferSuccess(transferData) {
    try {
      const { user, amount, fromAccount, toAccount } = transferData;

      await this.notificationService.createNotification({
        recipients: user,
        title: "💱 Transfer Completed Successfully",
        message: `Your transfer of $${amount} has been completed successfully.`,
        type: "transfer_success",
        priority: "medium",
        data: {
          amount,
          fromAccount: fromAccount.mt5Account || fromAccount,
          toAccount: toAccount.mt5Account || toAccount,
        },
        relatedModel: "Transfer",
        relatedId: transferData._id,
      });
    } catch (error) {
      console.error("Error handling transfer success notification:", error);
    }
  }

  // 5. New Referral Notifications
  async handleNewReferral(ibConfigData, referrerData) {
    try {
      const { userId: newUserId, referredBy } = ibConfigData;

      // Get new user details
      const User = require("../models/User");
      const newUser = await User.findById(newUserId).select(
        "firstName lastName email"
      );

      if (referrerData && newUser) {
        await this.notificationService.createNotification({
          recipients: referrerData._id,
          title: "👥 New Referral Joined!",
          message: `Congratulations! ${newUser.firstName} ${newUser.lastName} has joined using your referral code.`,
          type: "new_referral",
          priority: "medium",
          data: {
            referredUserName: `${newUser.firstName} ${newUser.lastName}`,
            referralCode: referredBy,
            joinDate: new Date().toLocaleDateString(),
          },
          relatedModel: "IBClientConfiguration",
          relatedId: ibConfigData._id,
        });
      }
    } catch (error) {
      console.error("Error handling new referral notification:", error);
    }
  }

  // 6. Ticket Update Notifications
  async handleTicketUpdate(ticketData, updateType = "update") {
    try {
      const { createdBy, ticketNumber, subject, status, priority, assignedTo } =
        ticketData;

      // Notify ticket creator
      const updateMessages = {
        created:
          "Your support ticket has been created and assigned to our team.",
        updated: "Your support ticket has been updated.",
        status_changed: `Your support ticket status has been changed to ${status}.`,
        message_added: "A new message has been added to your support ticket.",
      };

      const ticketIcons = {
        new: "🆕",
        open: "📂",
        inProgress: "🔄",
        resolved: "✅",
        closed: "🔒",
      };

      await this.notificationService.createNotification({
        recipients: createdBy,
        title: `${ticketIcons[status] || "🎫"} Ticket ${ticketNumber} ${
          updateType === "created" ? "Created" : "Updated"
        }`,
        message: updateMessages[updateType] || updateMessages["updated"],
        type: "ticket_update",
        priority: priority === "high" ? "high" : "medium",
        data: {
          ticketNumber,
          subject,
          status,
          priority,
          updateType,
        },
        relatedModel: "Ticket",
        relatedId: ticketData._id,
      });

      // Notify all admins
      const adminUsers = await this.notificationService.getAdminUsers();
      if (adminUsers.length > 0) {
        await this.notificationService.createNotification({
          recipients: adminUsers.map((admin) => admin._id),
          title: `🎫 Ticket ${ticketNumber} ${
            updateType === "created" ? "Created" : "Updated"
          }`,
          message: `Ticket ${ticketNumber} has been ${
            updateType === "created" ? "created" : "updated"
          } and requires attention.`,
          type: "ticket_update",
          priority: priority === "high" ? "high" : "medium",
          data: {
            ticketNumber,
            subject,
            status,
            priority,
            updateType,
            clientId: createdBy,
          },
          relatedModel: "Ticket",
          relatedId: ticketData._id,
        });
      }
    } catch (error) {
      console.error("Error handling ticket update notification:", error);
    }
  }

  // 7. Profile Update Notifications (Admin only)
  async handleProfileUpdate(profileData, userId) {
    try {
      const User = require("../models/User");
      const user = await User.findById(userId).select(
        "firstName lastName email"
      );

      if (user) {
        const adminUsers = await this.notificationService.getAdminUsers();
        if (adminUsers.length > 0) {
          await this.notificationService.createNotification({
            recipients: adminUsers.map((admin) => admin._id),
            title: "👤 Client Profile Updated",
            message: `${user.firstName} ${user.lastName} has updated their profile information.`,
            type: "profile_update",
            priority: "low",
            data: {
              clientName: `${user.firstName} ${user.lastName}`,
              clientEmail: user.email,
              clientId: userId,
              updateDate: new Date().toLocaleDateString(),
            },
            relatedModel: "Profile",
            relatedId: profileData._id,
          });
        }
      }
    } catch (error) {
      console.error("Error handling profile update notification:", error);
    }
  }

  // 8. New User Signup Notifications (Admin only)
  async handleNewUserSignup(userData, ibConfigData = null) {
    try {
      const { _id, firstName, lastName, email } = userData;
      const isIBUser = !!ibConfigData;

      const adminUsers = await this.notificationService.getAdminUsers();
      if (adminUsers.length > 0) {
        await this.notificationService.createNotification({
          recipients: adminUsers.map((admin) => admin._id),
          title: `🆕 New ${isIBUser ? "IB Partner" : "Client"} Registration`,
          message: `A new ${
            isIBUser ? "IB partner" : "client"
          } ${firstName} ${lastName} has registered on the platform.`,
          type: "new_signup",
          priority: isIBUser ? "medium" : "low",
          data: {
            userName: `${firstName} ${lastName}`,
            email,
            isIBUser,
            referredBy: ibConfigData?.referredBy || null,
            signupDate: new Date().toLocaleDateString(),
            clientId: _id,
          },
          relatedModel: "User",
          relatedId: _id,
        });
      }
    } catch (error) {
      console.error("Error handling new user signup notification:", error);
    }
  }

  // 9. Message Added to Ticket Notifications
  async handleTicketMessageAdded(messageData, ticketData) {
    try {
      const { sender, content, ticketId } = messageData;
      const { createdBy, ticketNumber, subject } = ticketData;

      // Don't notify if sender is the ticket creator
      if (sender.toString() === createdBy.toString()) {
        // Notify admins about new message from client
        const adminUsers = await this.notificationService.getAdminUsers();
        if (adminUsers.length > 0) {
          await this.notificationService.createNotification({
            recipients: adminUsers.map((admin) => admin._id),
            title: `💬 New Message in Ticket ${ticketNumber}`,
            message: `Client has added a new message to ticket ${ticketNumber}.`,
            type: "ticket_update",
            priority: "medium",
            data: {
              ticketNumber,
              subject,
              messagePreview: content.substring(0, 100),
              updateType: "message_added",
              clientId: createdBy,
            },
            relatedModel: "Message",
            relatedId: messageData._id,
          });
        }
      } else {
        // Notify ticket creator about admin response
        await this.notificationService.createNotification({
          recipients: createdBy,
          title: `💬 New Response to Ticket ${ticketNumber}`,
          message: "You have received a new response to your support ticket.",
          type: "ticket_update",
          priority: "medium",
          data: {
            ticketNumber,
            subject,
            messagePreview: content.substring(0, 100),
            updateType: "message_added",
          },
          relatedModel: "Message",
          relatedId: messageData._id,
        });
      }
    } catch (error) {
      console.error("Error handling ticket message notification:", error);
    }
  }

  // 10. Password Changed Notifications
  async handlePasswordChanged(accountData) {
    try {
      const {
        user,
        mt5Account,
        changedPasswords,
        accountType,
        investor_pwd,
        master_pwd,
        platform,
      } = accountData;

      // Get user details
      const User = require("../models/User");
      const userDetails = await User.findById(user).select(
        "firstName lastName email"
      );

      if (!userDetails) {
        console.error("User not found for password change notification");
        return;
      }

      // Determine which passwords were changed
      const passwordTypes = [];
      if (changedPasswords.includes("investor_pwd")) {
        passwordTypes.push("Investor Password");
      }
      if (changedPasswords.includes("master_pwd")) {
        passwordTypes.push("Master Password");
      }

      const passwordText =
        passwordTypes.length > 1 ? "passwords have" : "password has";

      const passwordList = passwordTypes.join(" and ");

      // Notify the client
      await this.notificationService.createNotification({
        recipients: user,
        title: "🔐 Account Password Updated",
        message: `Your ${passwordList} for MT5 account ${mt5Account} ${passwordText} been successfully updated.`,
        type: "password_changed",
        priority: "high",
        data: {
          mt5Account,
          accountType,
          changedPasswords: passwordTypes,
          investor_pwd,
          master_pwd,
          platform,
          changeDate: new Date().toLocaleDateString(),
          changeTime: new Date().toLocaleTimeString(),
        },
        relatedModel: "Account",
        relatedId: accountData._id,
      });

      // Notify all admins for security purposes
      const adminUsers = await this.notificationService.getAdminUsers();
      console.log("Admin users for password change notification:", adminUsers);
      if (adminUsers.length > 0) {
        await this.notificationService.createNotification({
          recipients: adminUsers.map((admin) => admin._id),
          title: "🔐 Client Password Changed",
          message: `Client ${userDetails.firstName} ${userDetails.lastName} has updated their ${passwordList} for MT5 account ${mt5Account}.`,
          type: "password_changed",
          priority: "medium",
          data: {
            mt5Account,
            accountType,
            changedPasswords: passwordTypes,
            investor_pwd,
            master_pwd,
            platform,
            clientId: user,
            clientName: `${userDetails.firstName} ${userDetails.lastName}`,
            clientEmail: userDetails.email,
            changeDate: new Date().toLocaleDateString(),
            changeTime: new Date().toLocaleTimeString(),
          },
          relatedModel: "Account",
          relatedId: accountData._id,
        });
      }
    } catch (error) {
      console.error("Error handling password change notification:", error);
    }
  }

  // 11. KYC Submitted Notifications
  async handleKycSubmitted(profileData, userId) {
    try {
      const User = require("../models/User");
      const user = await User.findById(userId).select(
        "firstName lastName firstname lastname email",
      );

      if (!user) {
        return;
      }

      const userName =
        `${user.firstName || user.firstname || ""} ${user.lastName || user.lastname || ""}`.trim();

      await this.notificationService.createNotification({
        recipients: userId,
        title: "KYC Documents Submitted",
        message:
          "Your KYC documents were submitted successfully and are now under review.",
        type: "kyc_status",
        priority: "medium",
        data: {
          status: "submitted",
          submittedAt: new Date().toLocaleString(),
        },
        relatedModel: "Profile",
        relatedId: profileData._id,
      });

      const adminUsers = await this.notificationService.getAdminUsers();
      if (adminUsers.length > 0) {
        await this.notificationService.createNotification({
          recipients: adminUsers.map((admin) => admin._id),
          title: "New KYC Submission",
          message: `${userName || "A client"} has submitted KYC documents for review.`,
          type: "kyc_status",
          priority: "medium",
          data: {
            status: "submitted",
            submittedAt: new Date().toLocaleString(),
            clientName: userName,
            clientEmail: user.email,
          },
          relatedModel: "Profile",
          relatedId: profileData._id,
        });
      }
    } catch (error) {
      console.error("Error handling KYC submitted notification:", error);
    }
  }

  // 12. KYC Status Change Notifications
  async handleKycStatusChange({ userId, profileId, status, reason }) {
    try {
      await this.notificationService.createNotification({
        recipients: userId,
        title:
          status === "approved"
            ? "KYC Approved"
            : status === "rejected"
              ? "KYC Rejected"
              : "KYC Status Updated",
        message:
          status === "approved"
            ? "Your KYC verification has been approved successfully."
            : status === "rejected"
              ? "Your KYC verification was rejected. Please review the feedback and resubmit your documents."
              : `Your KYC status has been updated to ${status}.`,
        type: "kyc_status",
        priority: status === "rejected" ? "high" : "medium",
        data: {
          status,
          reason,
          reviewedAt: new Date().toLocaleString(),
        },
        relatedModel: "Profile",
        relatedId: profileId,
      });
    } catch (error) {
      console.error("Error handling KYC status notification:", error);
    }
  }

  // PAMM investment/redemption request status notifications
  async handlePammInvestmentStatusChange(transactionData, previousStatus) {
    try {
      const { investor, amount, status, type, remarks } = transactionData;
      const isRedemption = type === "redemption";

      const statusMessages = {
        pending: isRedemption
          ? "Your PAMM redemption request is being processed."
          : "Your PAMM investment request is being processed.",
        completed: isRedemption
          ? "Your PAMM redemption has been approved and processed."
          : "Your PAMM investment has been approved and processed.",
        rejected: isRedemption
          ? "Your PAMM redemption request has been rejected. Please contact support for more information."
          : "Your PAMM investment request has been rejected. Please contact support for more information.",
      };

      const statusIcons = { pending: "⏳", completed: "✅", rejected: "❌" };

      await this.notificationService.createNotification({
        recipients: investor,
        title: `${statusIcons[status] || "ℹ️"} PAMM ${isRedemption ? "Redemption" : "Investment"} ${status === "completed" ? "Approved" : status.charAt(0).toUpperCase() + status.slice(1)}`,
        message: statusMessages[status] || `Your PAMM request status is now ${status}.`,
        type: "pamm_investment_status",
        priority: status === "rejected" ? "high" : "medium",
        data: { amount, status, type, remarks, previousStatus },
        relatedModel: "PammInvestment",
        relatedId: transactionData._id,
      });

      if (status === "pending" && previousStatus !== "pending") {
        const adminUsers = await this.notificationService.getAdminUsers();
        if (adminUsers.length > 0) {
          await this.notificationService.createNotification({
            recipients: adminUsers.map((admin) => admin._id),
            title: `💰 New PAMM ${isRedemption ? "Redemption" : "Investment"} Request`,
            message: `A new PAMM ${isRedemption ? "redemption" : "investment"} request of $${amount} has been submitted and requires approval.`,
            type: "pamm_investment_status",
            priority: "medium",
            data: { amount, status, type, investor },
            relatedModel: "PammInvestment",
            relatedId: transactionData._id,
          });
        }
      }
    } catch (error) {
      console.error("Error handling PAMM investment status notification:", error);
    }
  }

  // Notifies a fund's manager after an automated settlement run credits
  // them management/performance fees.
  async handlePammSettlement(pamm, feeAmount) {
    try {
      if (!feeAmount || feeAmount <= 0) return;

      await this.notificationService.createNotification({
        recipients: pamm.manager,
        title: "📈 PAMM Fund Settled",
        message: `Your fund "${pamm.name}" was settled. $${feeAmount.toFixed(2)} in fees was credited to your account.`,
        type: "pamm_settlement",
        priority: "low",
        data: { pammId: pamm._id, feeAmount, navPerUnit: pamm.navPerUnit },
        relatedModel: "Pamm",
        relatedId: pamm._id,
      });
    } catch (error) {
      console.error("Error handling PAMM settlement notification:", error);
    }
  }
}

module.exports = NotificationTriggers;
