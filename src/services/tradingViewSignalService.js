// Turns an indicator signal (BUY, SELL, LS_UP, LS_DOWN) into the same
// position_opened / position_closed events the copy engine already uses.
// The TradingView indicator acts as the "master": followers copy its signals.
// No new database table or paid service is needed.

const SIGNAL_SIDES = {
  BUY: 'buy',
  SELL: 'sell',
  LS_UP: 'buy',
  LS_DOWN: 'sell'
};

// open = the position currently open for this account + symbol, or null.
// One net position per symbol: a signal on the same side is ignored (so BUY and
// LS_UP on the same candle only open once), a signal on the other side closes
// the open position first and then opens the new one.
function planActions(open, side) {
  if (open && open.side === side) {
    return [];
  }
  const actions = [];
  if (open) {
    actions.push({ type: 'close', externalPositionId: open.externalPositionId, side: open.side });
  }
  actions.push({ type: 'open', side });
  return actions;
}

function validateSignalPayload(body) {
  if (!body || typeof body !== 'object') {
    return 'JSON body is required.';
  }
  if (!body.token || typeof body.token !== 'string') {
    return 'token is required (the webhook token of your master account).';
  }
  if (!SIGNAL_SIDES[body.signal]) {
    return `signal must be one of: ${Object.keys(SIGNAL_SIDES).join(', ')}.`;
  }
  if (!body.symbol || typeof body.symbol !== 'string') {
    return 'symbol is required.';
  }
  const size = Number(body.size);
  if (!Number.isFinite(size) || size <= 0) {
    return 'size must be a positive number.';
  }
  return null;
}

module.exports = { SIGNAL_SIDES, planActions, validateSignalPayload };
