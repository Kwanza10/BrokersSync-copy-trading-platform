const crypto = require('crypto');
const db = require('../lib/db');

function toDTO(row) {
  return {
    id: row.id,
    sourceAccountId: row.source_account_id,
    eventType: row.event_type,
    symbol: row.symbol,
    side: row.side,
    size: row.size === null ? null : Number(row.size),
    price: row.price === null ? null : Number(row.price),
    sl: row.sl === null ? null : Number(row.sl),
    tp: row.tp === null ? null : Number(row.tp),
    externalPositionId: row.external_position_id,
    source: row.source,
    status: row.status,
    receivedAt: row.received_at
  };
}

// Durable dedup key for a retried delivery of the *same* event - mirrors the
// fields tradeLockerPoller's positionHash() already uses to detect a real
// change (side/size/sl/tp), plus the identity of which position/event this
// is. A retry resends the same payload byte-for-byte, so it hashes
// identically and gets rejected by the DB's unique index; a genuinely new
// event for the same position (e.g. a later, different SL change) won't
// collide because its payload differs.
// Bucket the key to a short rolling window (5 min) instead of hashing
// only the position's logical state forever. A genuine retried delivery
// lands in the same bucket and still collides (good, still deduped). But
// without this bucket, two DIFFERENT real events could hash identically
// forever: if TradeLocker ever reuses a numeric externalPositionId after
// a prior position on it fully closed, and the new position opens with
// the same side/size/sl/tp as the old one, its position_opened event
// would collide with the stale key and silently vanish. Bucketing bounds
// the collision risk to ~5 minutes instead of indefinitely.
const DEDUP_WINDOW_MS = 5 * 60 * 1000;

function computeIdempotencyKey({ sourceAccountId, eventType, externalPositionId, side, size, sl, tp }) {
  const timeBucket = Math.floor(Date.now() / DEDUP_WINDOW_MS);
  const payload = [sourceAccountId, eventType, externalPositionId, side, size, sl, tp, timeBucket].join('|');
  return crypto.createHash('sha256').update(payload).digest('hex');
}

async function createTradeEvent(input) {
  const {
    sourceAccountId,
    eventType,
    symbol,
    side,
    size,
    price,
    sl,
    tp,
    externalPositionId,
    source,
    rawPayload
  } = input;

  const id = crypto.randomUUID();
  const idempotencyKey = computeIdempotencyKey(input);
  const result = await db.query(
    `INSERT INTO copy_trade_events
       (id, source_account_id, event_type, symbol, side, size, price, sl, tp, external_position_id, source, raw_payload, status, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'received', $13)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [
      id,
      sourceAccountId,
      eventType,
      symbol,
      side || null,
      size ?? null,
      price ?? null,
      sl ?? null,
      tp ?? null,
      externalPositionId || null,
      source,
      rawPayload ? JSON.stringify(rawPayload) : null,
      idempotencyKey
    ]
  );

  if (result.rows.length === 0) {
    return { isDuplicate: true, idempotencyKey, sourceAccountId, eventType, externalPositionId };
  }

  return { ...toDTO(result.rows[0]), isDuplicate: false };
}

// Used when a position_closed event arrives, to find the original
// position_opened event for the same master position so followers' mirrored
// positions can be closed too.
async function findOpenEventByExternalId(sourceAccountId, externalPositionId) {
  const result = await db.query(
    `SELECT * FROM copy_trade_events
     WHERE source_account_id = $1 AND external_position_id = $2 AND event_type = 'position_opened'
     ORDER BY received_at DESC
     LIMIT 1`,
    [sourceAccountId, externalPositionId]
  );
  return result.rows[0] ? toDTO(result.rows[0]) : null;
}

// Used by tradeLockerPoller on startup to rehydrate its in-memory
// lastPositions state, so a process restart doesn't make it treat
// already-open master positions as newly opened and re-copy them. Latest
// event per external_position_id, excluding ones whose latest state is
// already closed.
async function getOpenPositionsForAccount(sourceAccountId) {
  const result = await db.query(
    `SELECT DISTINCT ON (external_position_id) *
     FROM copy_trade_events
     WHERE source_account_id = $1 AND external_position_id IS NOT NULL
     ORDER BY external_position_id, received_at DESC`,
    [sourceAccountId]
  );
  return result.rows.filter((row) => row.event_type !== 'position_closed').map(toDTO);
}

// Webhook bridges (MT4/5 EAs) retry on timeout/connection-reset without any
// idempotency key of their own, so the same position event can arrive twice.
// Fast pre-check used by the webhook route to skip queuing entirely on an
// obvious retry. This is a best-effort check (a same-millisecond double
// retry could theoretically slip past it) - the idempotency_key unique
// index in createTradeEvent is the real backstop that guarantees a
// duplicate can never actually be processed twice, even if this check
// misses one.
async function findRecentDuplicate({ sourceAccountId, eventType, externalPositionId, side, size, sl, tp, windowMs = 15000 }) {
  const result = await db.query(
    `SELECT * FROM copy_trade_events
     WHERE source_account_id = $1
       AND event_type = $2
       AND external_position_id = $3
       AND side IS NOT DISTINCT FROM $4
       AND size IS NOT DISTINCT FROM $5
       AND sl IS NOT DISTINCT FROM $6
       AND tp IS NOT DISTINCT FROM $7
       AND received_at >= NOW() - ($8 || ' milliseconds')::interval
     ORDER BY received_at DESC
     LIMIT 1`,
    [sourceAccountId, eventType, externalPositionId, side || null, size ?? null, sl ?? null, tp ?? null, windowMs]
  );
  return result.rows[0] ? toDTO(result.rows[0]) : null;
}

// Latest indicator (TradingView) event for one symbol on one account. Used to
// rebuild "is a position open right now?" after a server restart.
async function findLatestTradingViewEvent(sourceAccountId, symbol) {
  const result = await db.query(
    `SELECT * FROM copy_trade_events
     WHERE source_account_id = $1 AND symbol = $2 AND external_position_id LIKE 'tv-%'
     ORDER BY received_at DESC
     LIMIT 1`,
    [sourceAccountId, symbol]
  );
  return result.rows[0] ? toDTO(result.rows[0]) : null;
}

async function updateStatus(id, status) {
  await db.query(`UPDATE copy_trade_events SET status = $1 WHERE id = $2`, [status, id]);
}

async function listRecentForUser(userId, limit = 50) {
  const result = await db.query(
    `SELECT e.* FROM copy_trade_events e
     JOIN broker_accounts a ON a.id = e.source_account_id
     WHERE a.user_id = $1
     ORDER BY e.received_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return result.rows.map(toDTO);
}

module.exports = {
  createTradeEvent,
  updateStatus,
  listRecentForUser,
  findOpenEventByExternalId,
  getOpenPositionsForAccount,
  findRecentDuplicate,
  findLatestTradingViewEvent,
  toDTO
};
