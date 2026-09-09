# Project Status Report — BrokersSync Copy Trading Platform

_Generated 2026-09-09 from the repository state on `main` (55 commits, first
commit 2026-08-09, most recent 2026-08-30)._

## 1. What this is

An Express/Node backend + static dashboard for multi-tenant copy trading:
users connect broker accounts (TradeLocker native REST, plus MT4/MT5 via a
bridge EA and command queue), designate master/follower relationships, and
the platform mirrors trades between them. It also carries the scaffolding
for a broader "enterprise platform" — wallet/settlement/compliance/strategy
marketplace/analytics modules — around that copy-trading core.

Deployed continuously: `main` pushes trigger a GitHub Actions job
(`.github/workflows/deploy.yml`) that SSHes into a VPS, `git pull`s, and
restarts the app under `pm2`. There's a live production target, not just a
local dev scaffold.

## 2. Stack

- **Runtime**: Node.js (Express 4), no TypeScript/build step — CommonJS
  throughout.
- **Data**: PostgreSQL (`pg`) for durable records, Redis client present
  (`src/services/redisService.js`, `src/routes/redis.js`) for
  caching/pub-sub, plus a significant amount of **in-process `Map()`
  state** (see §4).
- **Auth**: JWT (`jsonwebtoken`) + bcrypt password hashing, plus Google
  Sign-In support (`google-auth-library`).
- **Frontend**: a single static dashboard (`public/dashboard.html` +
  `public/bsync-app.js`), no framework/bundler.
- **Broker integration**: `tradeLockerService.js` / `tradeLockerPoller.js`
  talk to TradeLocker's REST API directly; `mt-bridge-ea/` +
  `mtBridgeService.js` + `routes/ea.js` handle MT4/MT5 via a bridge EA that
  polls a command queue (webhook + poll-driven, with idempotency-key
  dedup between the two paths).
- **Tests**: `node --test` (built-in test runner), 27 tests across 12
  files, all passing once `npm install` is run (see §5).

## 3. Feature surface (routes actually mounted in `src/app.js`)

| Area | Route prefix | Notes |
|---|---|---|
| Auth | `/api/auth` | login/register, Google sign-in, password reset |
| Broker accounts | `/api/accounts`, `/api/broker-accounts`, `/api/brokers` | connect TradeLocker/MT4/MT5 accounts, bulk multi-account creation |
| Copy trading | `/api/copy`, `/api/copy-relationships` | relationship CRUD, engine control |
| MT4/5 bridge | `/api/bridge`, `/api/ea` | EA command queue |
| Symbol mapping | `/api/symbol-mappings` | per-broker symbol aliasing |
| Webhooks | `/api/webhook` | inbound trade events |
| Trade feed | `/api/trade-feed` | live feed |
| Strategies | `/api/strategies` | marketplace-style listings |
| Wallet / Settlements / Transfers | `/api/wallet`, `/api/settlements`, `/api/transfers` | ledger, payouts, internal movement |
| Compliance | `/api/compliance` | audit events |
| Admin | `/api/admin` | limits on masters/followers per user, metrics |
| Analytics / Market | `/api/analytics`, `/api/market` | includes a level2 order book endpoint |
| Notifications | `/api/notifications` | |
| AI assistant | `/api/ai-assistant` | |
| Settings | `/api/settings` | |

Every route module above is required and mounted — nothing in the list is
dead scaffolding at the wiring level (whether each is fully implemented
end-to-end is a separate question; see §6).

## 4. Data persistence model — the biggest architectural fact to know

This is a **hybrid** system, and the split matters:

- **Postgres-backed** (durable across `pm2 restart` / deploys):
  `broker_accounts`, `copy_relationships` / `trade_copy_relationships`,
  `copy_trade_events`, `copy_executions`, `symbol_mappings`,
  `bridge_commands`, `compliance_events`, `admin_alerts`, `app_settings`,
  and (as of `ccb2a8f`, 2026-08-28) `users`.
- **In-process `Map()` only** (`src/lib/inMemoryStore.js`):
  `strategies` and `allocations`, plus admin metrics counters.

The commit history shows this was already a live production bug once:
`ccb2a8f "Rehydrate users from Postgres on boot - restarts were wiping all
accounts"` — the `users` map was the login source of truth, Postgres was
written to but never read back from, so every deploy silently logged
everyone out and orphaned their broker-account foreign keys. That's fixed
for users. **`strategies` and `allocations` have not received the same
fix** — they are still boot-to-boot ephemeral, which on a
deploy-on-every-push pipeline means the strategy marketplace and
allocation state most likely do not survive a normal deploy today. Worth
confirming and applying the same rehydration pattern if it hasn't already
happened after this snapshot.

## 5. Test suite

```
27 tests, 12 files, 27 passing, 0 failing (after `npm install`)
```

`node_modules/` is gitignored and wasn't present in this checkout;
`npm test` fails immediately with `Cannot find module 'pg'` until
`npm install` is run first — that's an environment-setup step, not a code
defect. `npm run lint` is just `node --check src/server.js` (a syntax
check, not a real linter) — no ESLint/Prettier config in the repo.

## 6. Recent development trajectory (last ~20 commits)

The last two weeks of history read as active production hardening rather
than new-feature work — a good sign for stability, worth noting for
planning:

- **Reliability/crash fixes**: unhandled Postgres pool error killing the
  process (`ce38126`), session-expiry (401) handling stranding users
  mid-flow (`80bc9c0`), stale TradeLocker session retry
  (`5d7a305`), duplicate-account and blank-account edge cases in Quick Add
  (`17115d8`, `116755e`).
- **Auth/UX polish**: standalone login page, password show/hide,
  password reset, Google sign-in, browser autofill fighting the login
  form (`c7fe8c1`).
- **Ops/deploy debugging**: temporary diagnostics and error banners added
  and then cleaned up (`8f66095`, `25e2578`, `90f600d`) — evidence of a
  real "why isn't this working in prod" cycle, since resolved.
- **Copy trading correctness**: idempotency-key dedup between the poller
  and webhook paths so the same trade isn't copied twice (`957f57d`
  history, `18:49` merge), SL/TP modifications now mirrored to followers.
- **Platform breadth**: MT4/MT5 bridge EA + command queue added
  wholesale (`22:16:32 Add MT4/MT5 copy-trade bridge`), then NinjaTrader
  support removed again (`Remove NinjaTrader as a supported platform`) —
  the broker-platform list has been actively trimmed, not just grown.

No TODO/FIXME markers remain in `src/`, `routes/`, or `public/` — either
genuinely clean or a sign that in-progress work isn't being marked inline
(commit messages are the more reliable trail here).

## 7. Known gaps / risks worth flagging

1. **Ephemeral strategies/allocations state** (§4) — likely the single
   highest-value next fix given the `users` precedent already found and
   fixed once.
2. **No real linter/formatter** — `npm run lint` doesn't actually lint.
3. **CI only runs on push to `main`** (`.github/workflows/deploy.yml`
   triggers on `push: branches: [main]`) — there's no workflow that runs
   tests on pull requests, so a bad PR can't fail CI before merge; it can
   only be caught after landing on `main`, which is also the branch that
   auto-deploys.
4. **Multi-broker surface is wide**: TradeLocker (native), MT4/MT5 (EA
   bridge), plus wallet/settlement/compliance/marketplace/analytics
   modules alongside the copy-trading core. Worth confirming with
   stakeholders which of these are meant to be production-real right now
   versus scaffolding for later, since it affects how much the "known
   gaps" above matter.

## 8. Suggested next steps

- Apply the same Postgres-rehydration-on-boot fix already used for
  `users` to `strategies` and `allocations`, or confirm they're
  intentionally ephemeral.
- Add a `pull_request` trigger to the CI workflow (test-only, no deploy)
  so PRs get a pass/fail signal before merging into the auto-deploying
  `main` branch.
- Introduce ESLint (even a minimal recommended config) given the
  route/service surface is now ~50 files and growing.
