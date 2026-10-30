const express = require('express');
const brokerAccountService = require('../services/brokerAccountService');
const tradeEventService = require('../services/tradeEventService');
const tradeQueue = require('../lib/tradeQueue');
const tradingViewSignalService = require('../services/tradingViewSignalService');

const router = express.Router();

const EVENT_TYPES = ['position_opened', 'position_closed', 'position_modified'];
const SIDES = ['buy', 'sell'];

function validatePayload(body) {
  if (!EVENT_TYPES.includes(body.eventType)) {
    return `eventType must be one of: ${EVENT_TYPES.join(', ')}`;
  }
  if (!body.symbol || typeof body.symbol !== 'string') {
    return 'symbol is required.';
  }
  if (!body.externalPositionId) {
    return 'externalPositionId is required so opens/closes/modifies can be correlated.';
  }
  if (body.eventType !== 'position_closed') {
    if (!SIDES.includes(body.side)) {
      return `side must be one of: ${SIDES.join(', ')} (required for ${body.eventType}).`;
    }
    if (typeof body.size !== 'number' || body.size <= 0) {
      return 'size must be a positive number.';
    }
  }
  return null;
}

// Bridges (MT4/5 EAs) don't log in - each BrokerAccount carries
// its own webhook token, issued once at creation (POST /api/broker-accounts).
router.post('/trade', async (req, res) => {
  const token = req.headers['x-webhook-token'];
  if (!token) {
    return res.status(401).json({ error: 'X-Webhook-Token header is required.' });
  }

  let account;
  try {
    account = await brokerAccountService.getBrokerAccountByWebhookToken(token);
  } catch (error) {
    console.error('Webhook token lookup failed:', error.message);
    return res.status(500).json({ error: 'Unable to verify webhook token.' });
  }

  if (!account || account.status !== 'active') {
    return res.status(401).json({ error: 'Invalid or inactive webhook token.' });
  }

  brokerAccountService.touchLastSeen(account.id).catch((error) => {
    console.error('Failed to update last-seen for webhook account', account.id, error.message);
  });

  const validationError = validatePayload(req.body || {});
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const externalPositionId = String(req.body.externalPositionId);

  // Bridges retry a webhook POST on timeout/connection-reset without any
  // idempotency key of their own, which would otherwise re-copy (or
  // re-close) the same master position to followers a second time. Treat a
  // same-state event for the same master position arriving again within a
  // few seconds as a retry, not a new event.
  try {
    const duplicate = await tradeEventService.findRecentDuplicate({
      sourceAccountId: account.id,
      eventType: req.body.eventType,
      externalPositionId,
      side: req.body.side || null,
      size: req.body.size ?? null,
      sl: req.body.sl ?? null,
      tp: req.body.tp ?? null
    });
    if (duplicate) {
      return res.status(200).json({ received: true, duplicate: true });
    }
  } catch (error) {
    console.error('Webhook idempotency check failed:', error.message);
    return res.status(500).json({ error: 'Unable to verify webhook event.' });
  }

  // Respond immediately so the sending bridge doesn't time out or retry;
  // actual copy-engine processing happens off the request/response cycle.
  res.status(200).json({ received: true });

  tradeQueue.push({
    sourceAccountId: account.id,
    eventType: req.body.eventType,
    symbol: req.body.symbol,
    side: req.body.side || null,
    size: req.body.size ?? null,
    price: req.body.price ?? null,
    sl: req.body.sl ?? null,
    tp: req.body.tp ?? null,
    externalPositionId,
    source: 'webhook',
    rawPayload: req.body
  });
});

// TradingView alerts cannot send custom headers, so this route takes the
// account's webhook token inside the JSON body instead (alerts only go out over
// HTTPS, and the token is only ever sent to this server).
// Body: { token, signal: BUY | SELL | LS_UP | LS_DOWN, symbol, size, price? }
// In memory: which position this route opened last, per account + symbol.
// (After a restart it is rebuilt from the saved events.)
const tvOpenPositions = new Map();

router.post('/tradingview', async (req, res) => {
  const body = req.body || {};
  const validationError = tradingViewSignalService.validateSignalPayload(body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  let account;
  try {
    account = await brokerAccountService.getBrokerAccountByWebhookToken(body.token);
  } catch (error) {
    console.error('TradingView webhook token lookup failed:', error.message);
    return res.status(500).json({ error: 'Unable to verify webhook token.' });
  }
  if (!account || account.status !== 'active') {
    return res.status(401).json({ error: 'Invalid or inactive webhook token.' });
  }
  if (account.role !== 'master' && account.role !== 'both') {
    return res.status(403).json({ error: 'This account is not a master account.' });
  }

  brokerAccountService.touchLastSeen(account.id).catch((error) => {
    console.error('Failed to update last-seen for TradingView account', account.id, error.message);
  });

  const symbol = body.symbol.toUpperCase();
  const side = tradingViewSignalService.SIGNAL_SIDES[body.signal];
  const size = Number(body.size);
  const price = body.price === undefined || body.price === null ? null : Number(body.price);
  const key = `${account.id}|${symbol}`;

  try {
    let open = tvOpenPositions.get(key);
    if (open === undefined) {
      const latest = await tradeEventService.findLatestTradingViewEvent(account.id, symbol);
      open = latest && latest.eventType !== 'position_closed'
        ? { side: latest.side, externalPositionId: latest.externalPositionId }
        : null;
    }

    const actions = tradingViewSignalService.planActions(open, side);
    if (actions.length === 0) {
      tvOpenPositions.set(key, open);
      return res.status(200).json({ received: true, ignored: `a ${side} position is already open` });
    }

    // Set before any await below so a second alert in the same instant sees the new state
    let nextOpen = open;
    for (const action of actions) {
      if (action.type === 'close') {
        tradeQueue.push({
          sourceAccountId: account.id,
          eventType: 'position_closed',
          symbol,
          side: null,
          size: null,
          price,
          sl: null,
          tp: null,
          externalPositionId: action.externalPositionId,
          source: 'webhook',
          rawPayload: { signal: body.signal, symbol, price }
        });
        nextOpen = null;
      } else {
        const externalPositionId = `tv-${symbol}-${Date.now()}`;
        tradeQueue.push({
          sourceAccountId: account.id,
          eventType: 'position_opened',
          symbol,
          side: action.side,
          size,
          price,
          sl: null,
          tp: null,
          externalPositionId,
          source: 'webhook',
          rawPayload: { signal: body.signal, symbol, size, price }
        });
        nextOpen = { side: action.side, externalPositionId };
      }
    }
    tvOpenPositions.set(key, nextOpen);

    return res.status(200).json({ received: true, actions: actions.map((a) => `${a.type} ${a.side}`) });
  } catch (error) {
    console.error('TradingView webhook failed:', error.message);
    return res.status(500).json({ error: 'Unable to process signal.' });
  }
});

module.exports = router;
