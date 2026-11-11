<div align="center">

# 🏦 Forex CRM — Backend API

**The REST + real-time API behind a multi-role forex brokerage CRM.**
Client accounts, payments, MT5 trade sync, copy trading, PAMM, IB commissions and support, all in one Node.js service.

![Node.js](https://img.shields.io/badge/Node.js-Express_4-339933?logo=nodedotjs&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-Mongoose_8-47A248?logo=mongodb&logoColor=white)
![Socket.IO](https://img.shields.io/badge/Socket.IO-4-010101?logo=socketdotio&logoColor=white)
![Stripe](https://img.shields.io/badge/Payments-Stripe-635BFF?logo=stripe&logoColor=white)
![JWT](https://img.shields.io/badge/Auth-JWT_+_CSRF-000000?logo=jsonwebtokens&logoColor=white)
![Relaya](https://img.shields.io/badge/Webhooks-Relaya-14b886)

[Features](#-features) · [Architecture](#-architecture) · [Getting started](#-getting-started) · [Configuration](#-configuration) · [API](#-api-overview) · [Scripts](#-scripts)

</div>

---

## 🧭 Overview

This service powers both CRM clients:

- **[crmFrontend](https://github.com/dhirajray-12/crmFrontend)**, the React web app
- **[App](https://github.com/dhirajray-12/App)**, the Flutter mobile and desktop app

It serves four roles (**client**, **admin / sub-admin**, **agent** and **super admin**) and keeps trading data in sync with an external MT5 platform in the background.

---

## ✨ Features

| Area | Highlights |
|---|---|
| 🔐 **Auth & sessions** | JWT access + refresh tokens in httpOnly cookies, CSRF protection, multi-role login, OTP, device sessions, admin → client impersonation |
| 💰 **Money movement** | Deposits, withdrawals and internal transfers with admin approval flows. **Stripe** card deposits and withdrawals, with webhooks delivered and verified through **[Relaya](https://github.com/dhirajray-12/relaya)** |
| 📊 **Trading accounts** | MT5 account creation, leverage and groups, statements, daily performance, live prices and trade sync over WebSocket |
| 🤝 **Copy trading** | Masters, copiers, ratings and trade copying |
| 📈 **PAMM** | Funds, investments and automated settlement |
| 🧑‍🤝‍🧑 **IB / Partners** | Referral trees, flat and tiered commission configuration, commission processing and IB withdrawals |
| 🎫 **Support** | Tickets with real-time chat over Socket.IO |
| 🔔 **Notifications** | In-app (real-time) and email notifications, email logs |
| 📉 **Analytics** | Admin dashboards, revenue analytics, client risk data |
| 🤖 **AI assistant** | Client trading assistant with market sentiment and news (OpenAI-compatible provider) |
| 📄 **Exports** | PDF, Excel and Word statements and reports |

---

## 🧱 Architecture

```
              crmFrontend (React)        App (Flutter)
                        │   REST + Socket.IO   │
                        ▼                      ▼
┌──────────────────────────────────────────────────────────────┐
│  Express API  ·  auth / CSRF / rate limit / validation       │
│  routes → controllers → services → Mongoose models           │
├──────────────────────────────────────────────────────────────┤
│  Socket.IO hub: notifications, chat, live account updates    │
├──────────────────────────────────────────────────────────────┤
│  Background jobs (node-cron)                                 │
│  trade & account sync · open-trade sync · price feed         │
│  PAMM settlement · commissions · cleanup · health checks     │
└──────────────┬──────────────────┬──────────────┬─────────────┘
               ▼                  ▼              ▼
           MongoDB          MT5 API / WS     Stripe (via Relaya),
                                             Cloudinary, SMTP, AI
```

| Layer | Technology |
|---|---|
| Runtime | Node.js, Express 4 |
| Database | MongoDB with Mongoose 8 |
| Real-time | Socket.IO, `ws` (MT5 price, trade and account streams) |
| Auth | `jsonwebtoken`, bcrypt, cookie-based sessions, CSRF tokens |
| Validation | Joi, Zod |
| Security | helmet, express-mongo-sanitize, xss-clean, hpp, express-rate-limit, CORS allow-list |
| Jobs | node-cron |
| Payments | Stripe, `relaya-node` |
| Files | multer, express-fileupload, Cloudinary |
| Docs & exports | pdfkit, exceljs, docx, node-xlsx |
| Observability | winston, morgan, prom-client, slow-request logging |

---

## 🚀 Getting started

### Prerequisites

- **Node.js** 20 or newer
- **MongoDB** 6+ (local or Atlas)
- Optional: access to the MT5 bridge API, a Stripe account, SMTP credentials and Cloudinary

### Install and run

```bash
git clone https://github.com/dhirajray-12/AppBackend.git
cd AppBackend
npm install

# create .env (see Configuration below), then:
npm start            # nodemon, auto-reloads on change
```

The server starts on `PORT` (default **3000**) and prints a startup banner. Check it:

```bash
curl http://localhost:3000/api/health
```

---

## 🔧 Configuration

Create a `.env` file in the project root. The server **refuses to start** without the three required variables.

### Required

| Variable | Description |
|---|---|
| `MONGO_URI` | MongoDB connection string |
| `JWT_SECRET` | Secret for access tokens |
| `JWT_REFRESH_SECRET` | Secret for refresh tokens |

### Core

| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP port | `3000` |
| `NODE_ENV` | `development` or `production` | `production` |
| `CLIENT_URL` | Web app URL (links in emails, CORS) | |
| `SERVER_URL` | Public URL of this API | |
| `ALLOWED_ORIGINS` | Comma-separated CORS allow-list | |
| `CSRF_COOKIE_DOMAIN` | Cookie domain for the CSRF token | |
| `JWT_EXPIRE` / `JWT_REFRESH_EXPIRE` | Token lifetimes | `30d` |
| `TIMEZONE` | Default CRM timezone | |

### Integrations

| Group | Variables |
|---|---|
| **MT5 platform** | `MT5_API_URL`, `MT5_API_KEY`, `MT5_WS_URL`, `MT5_PRICE_WS_URL`, `MANAGER_INDEX`, `COPY_API_URL`, `TRADE_ACTION_API_URL`, `DEALS_HISTORY_API_URL`, `ORDERS_HISTORY_API_URL`, `CHART_API_URL` |
| **Stripe** | `STRIPE_SECRET_KEY`, `STRIPE_CURRENCY`, `STRIPE_MIN_DEPOSIT`, `STRIPE_MAX_DEPOSIT` |
| **Relaya** | `RELAYA_SIGNING_SECRET`, the destination secret used to verify forwarded Stripe webhooks |
| **Email** | `EMAIL_SERVICE`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, `COMPANY_NAME`, `COMPANY_EMAIL`, `ADMIN_EMAIL` |
| **Uploads** | `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` (or `CLOUDINARY_URL`) |
| **Google sign-in** | `GOOGLE_CLIENT_ID` |
| **AI assistant** | `AI_PROVIDER`, `AI_API_URL`, `AI_API_KEY`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `GROQ_API_KEY`, `GNEWS_API_KEY` |
| **Market data** | `ENABLE_MARKET_PRICE_FEED`, `MARKET_PRICE_WS_URL`, `MARKET_PRICE_SYMBOLS`, `COINGECKO_API_KEY` |
| **Internal** | `INTERNAL_API_KEY` (service-to-service calls), `ALERT_WEBHOOK_URL` |

### Background jobs

Each sync job can be switched on or off and scheduled independently:

| Toggle | Schedule |
|---|---|
| `ENABLE_AUTO_SYNC` | `CRON_AUTO_SYNC` |
| `ENABLE_DAILY_SYNC` | `CRON_DAILY_SYNC` |
| `ENABLE_ACCOUNT_SYNC` | `CRON_ACCOUNT_SYNC` |
| `ENABLE_CLEANUP` | `CRON_CLEANUP` (keeps `DATA_RETENTION_DAYS`) |
| `ENABLE_HEALTH_CHECK` | `CRON_HEALTH_CHECK` |
| `ENABLE_TRADE_SYNC` / `ENABLE_OPEN_TRADE_SYNC` | `TRADE_SYNC_INTERVAL_MS`, `OPEN_TRADE_SYNC_INTERVAL_MS` |

> 🔒 Never commit `.env`. Keep Stripe, MT5, SMTP and AI keys in your host's secret store.

---

## 📡 API overview

All endpoints live under `/api`. Responses are JSON. After sign-in, state-changing requests must echo the `csrf_token` cookie in the `X-CSRF-Token` header.

<details>
<summary><b>System</b></summary>

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Liveness, uptime, DB / email / WebSocket status |
| `GET /api/status` | Service status |
| `GET /api/sync/status` | Background sync status |
| `POST /api/stripe/webhook` | Stripe events, forwarded and signed by Relaya |

</details>

<details>
<summary><b>Auth & profile</b></summary>

`/api/auth` · `/api/otp` · `/api/profile`

</details>

<details>
<summary><b>Client</b></summary>

| Prefix | Purpose |
|---|---|
| `/api/accounts` | Trading accounts |
| `/api/clientdeposits` · `/api/withdrawals` · `/api/transfers` | Money movement |
| `/api/transactions` · `/api/client/statement` | History and statements |
| `/api/client/dashboard` · `/api/daily-performance` | Dashboard data |
| `/api/trading` | Trading operations |
| `/api/copy` · `/api/copy-trade` · `/api/copy-rating` · `/api/copy-copier` | Copy trading |
| `/api/ibclients/commission` · `/api/ibclients/withdrawals` · `/api/ibclients/ib-configurations` | IB / partner program |
| `/api/client/assistant` | AI assistant |
| `/api/tickets` · `/api/notifications` | Support and notifications |

</details>

<details>
<summary><b>Admin</b></summary>

| Prefix | Purpose |
|---|---|
| `/api/admin/dashboard` · `/api/admin/revenue-analytics` | Dashboards and analytics |
| `/api/clients` · `/api/admin/clients` | Client management |
| `/api/admindeposits` · `/api/adminwithdrawals` · `/api/admin/transactions` | Payment approvals and oversight |
| `/api/admin/partners` · `/api/admin/ib-withdrawals` · `/api/ib-configurations` · `/api/ib-configurations-flat` | IB management |
| `/api/admin/subadmins` | Sub-admins and permissions |

</details>

<details>
<summary><b>Super admin & settings</b></summary>

`/api/superadmin` · `/api/app-settings` · `/api/leverages` · `/api/groups` · `/api/payment-methods` · `/api/exchanges`

</details>

For request and response shapes, see [BACKEND_NOTES.md](BACKEND_NOTES.md).

---

## 📂 Project structure

```
.
├── index.js            # Server bootstrap: middleware, routes, Socket.IO, jobs
├── config/             # Config + env validation, MongoDB connection
├── routes/             # Express routers (admin/, client/ and shared)
├── controllers/        # Request handlers
├── services/           # Business logic: MT5 sync, Stripe, PAMM, email, AI, cron
├── models/             # Mongoose schemas
├── middlewares/        # Auth, CSRF, rate limits, validation, errors, timing
├── Validator/          # Joi schemas
├── utils/              # Helpers
├── API/                # External API clients
├── scripts/            # Index management, benchmarks, seeding, migrations
└── web.config          # IIS reverse-proxy rewrite rules
```

---

## 📜 Scripts

| Command | Description |
|---|---|
| `npm start` | Start the server with nodemon |
| `npm run create:indexes` | Create MongoDB indexes |
| `npm run audit:indexes` | Check that indexes exist and are used |
| `npm run analyze:performance` | Analyse slow queries |
| `npm run optimize:db` | Create indexes, then analyse performance |
| `npm run seed-notifications` | Seed sample notifications |

---

## 🛡️ Security

- Passwords hashed with bcrypt; tokens only in httpOnly cookies
- CSRF double-submit tokens on every state-changing request
- Rate limiting on auth and sensitive endpoints
- Input sanitisation against NoSQL injection, XSS and HTTP parameter pollution
- Helmet security headers and a strict CORS allow-list
- Payment webhooks accepted only with a valid Relaya signature

---

## 🧩 Related projects

| Repo | Description |
|---|---|
| [crmFrontend](https://github.com/dhirajray-12/crmFrontend) | React + TypeScript web client |
| [App](https://github.com/dhirajray-12/App) | Flutter mobile and desktop client |
| [Relaya](https://github.com/dhirajray-12/relaya) | Webhook reliability platform used for Stripe events |

---

<div align="center">

Designed and built by **[Dhiraj Ray](https://github.com/dhirajray-12)**

</div>
