# BrokersSync — Copy Trading Platform

An enterprise copy-trading backend and dashboard: users connect broker
accounts as masters or followers, trades get mirrored between them in real
time, and admins get compliance, wallet, and marketplace tooling on top.

Live at **brokerssync.com**, auto-deployed from `main` (see below).

## What's implemented

- **Auth** — email/password + optional Google sign-in, JWT sessions, admin
  role gated by `ADMIN_EMAILS` (`src/routes/auth.js`, `src/middleware/auth.js`)
- **Broker accounts** — add/remove/restore broker accounts, duplicate-account
  guard, symbol mappings between brokers (`src/routes/broker-accounts.js`,
  `src/routes/symbol-mappings.js`)
- **TradeLocker integration** — native REST API, fully implemented: login,
  account discovery, live position polling (`src/services/tradeLockerService.js`,
  `src/services/tradeLockerPoller.js`)
- **MT4/MT5 integration** — via a custom Expert Advisor bridge in
  `mt-bridge-ea/` (poll-based, since MetaTrader can't accept inbound
  connections). **Written but not yet run against a live MT4/5 terminal** —
  see `mt-bridge-ea/README.md` for compile/setup steps and current status.
- **Copy engine** — master → follower trade fan-out with idempotency
  (duplicate event de-dupe) and a risk engine for position sizing
  (`src/services/copyEngine.js`, `src/services/copyExecutionService.js`,
  `src/services/riskEngine.js`)
- **Admin controls** — configurable per-user limits on masters/followers,
  compliance monitoring (`src/routes/admin.js`, `src/services/complianceService.js`)
- **Wallet, transfers & settlements** — internal ledger, payout review queue
  (`src/routes/wallet.js`, `src/routes/transfers.js`, `src/routes/settlements.js`)
- **Strategy marketplace & analytics** — listings, performance snapshots,
  filtering (`src/routes/marketplace.js`, `src/services/strategyMarketplaceService.js`)
- **Notifications, market data, system health, webhooks** — supporting
  services under `src/services/` and `src/routes/`
- Postgres for persistence (`database/schema.sql`, applied idempotently on
  every boot — see `src/lib/db.js`), Redis for caching/queues, WebSocket for
  live trade-feed pushes

## Local setup

```
npm install
cp .env.example .env   # fill in real secrets; Postgres/Redis must be reachable
npm run dev             # nodemon, auto-restart
# or
npm start
```

The server auto-picks the next free port if `PORT` (default 3000) is taken.

## Testing — current status

- **Unit tests**: `npm test` — 27 tests across `tests/*.test.js`, all
  passing. These mock `pg`/Redis, so they don't need a live database.
- **Integration smoke tests** (mocked Postgres, no real DB/network needed):
  - `node __smoketest_idempotency.js` — duplicate trade-event handling
  - `node __smoketest_mtbridge.js` — MT bridge command queue/poll/ack flow
  - Both currently pass.
- **CI**: GitHub Actions runs `npm test` on every push to `main`, then
  deploys to the production VPS via `pm2 restart` if it's green
  (`.github/workflows/deploy.yml`).

### What's still needed before this is "tested" end-to-end

1. **MT4/MT5 EA has never run against a real terminal.** It needs to be
   compiled in MetaEditor, attached to a demo account, and walked through the
   `mt-bridge-ea/README.md` setup once to confirm it behaves as the smoke
   tests assume.
2. **No integration test against a real TradeLocker account** (demo or live)
   has been run in this repo — only unit-level mocks.
3. **No load/soak test** of the copy engine's fan-out under multiple
   concurrent master→follower relationships.
4. Manual QA of the money-adjacent flows (wallet, transfers, settlements) has
   not been exercised against a real Postgres instance in this session.

## Deployment

- Push to `main` → CI runs tests → on success, SSHes into the production VPS,
  pulls, `npm ci`, and `pm2 restart brokerssync`.
- HTTPS is terminated by Caddy in front of the Node process
  (`.github/workflows/setup-https.yml`, one-time setup).

## Compliance docs

See `DISCLAIMERS.md`, `KYC_AML_POLICY.md`, `PRIVACY_POLICY.md`, and
`TERMS_OF_SERVICE.md` at the repo root.
