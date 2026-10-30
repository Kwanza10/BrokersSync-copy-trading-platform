// Turns an indicator signal (BUY, SELL, LS_UP, LS_DOWN, PRICE) into the same
// position_opened / position_modified / position_closed events the copy engine
// already uses. The TradingView indicator acts as the "master": followers copy
// its signals. No new database table or paid service is needed.
//
// Life of a trade: an entry signal opens two positions (legs). The opposite
// signal closes leg 1 and leaves leg 2 running as the "runner". The runner has
// no stop until it is RUNNER_ACTIVATE_DISTANCE in profit; after that a stop
// trails RUNNER_TRAIL_DISTANCE behind its best price. While a runner is open
// no new entries are taken. Prices come from PRICE alerts the indicator sends.
// "Distance" is a plain price move (a 10.0 move in the quote), on any symbol.

const SIGNAL_SIDES = {
  BUY: 'buy',
  SELL: 'sell',
  LS_UP: 'buy',
  LS_DOWN: 'sell'
};

const LEGS_PER_SIGNAL = 2;
const RUNNER_ACTIVATE_DISTANCE = Number(process.env.TV_RUNNER_ACTIVATE_DISTANCE || 100);
const RUNNER_TRAIL_DISTANCE = Number(process.env.TV_RUNNER_TRAIL_DISTANCE || 10);

// state = null (nothing open) or
// { side, entryPrice, legs: [{ externalPositionId }], runner: null | {
//     externalPositionId, side, entryPrice, best, stop } }
// stop is null until the runner reaches the activation distance.

function profitDistance(side, entryPrice, price) {
  return side === 'buy' ? price - entryPrice : entryPrice - price;
}

function moreFavorable(side, a, b) {
  return side === 'buy' ? Math.max(a, b) : Math.min(a, b);
}

function ignored(state, reason) {
  return { actions: [], nextState: state, ignored: reason };
}

function planEntry(state, side, price, idPrefix) {
  if (state && state.runner) {
    return ignored(state, 'a runner is still open, no new entries until it exits');
  }
  if (state && state.side === side) {
    return ignored(state, `a ${side} position is already open`);
  }

  if (state) {
    // Opposite signal: close leg 1, leg 2 keeps running as the runner.
    const [first, second] = state.legs;
    const runner = {
      externalPositionId: second.externalPositionId,
      side: state.side,
      entryPrice: state.entryPrice,
      best: moreFavorable(state.side, state.entryPrice, price),
      stop: null
    };
    return {
      actions: [{ type: 'close', externalPositionId: first.externalPositionId, side: state.side }],
      nextState: { side: state.side, entryPrice: state.entryPrice, legs: [], runner }
    };
  }

  const legs = [];
  const actions = [];
  for (let leg = 1; leg <= LEGS_PER_SIGNAL; leg += 1) {
    const externalPositionId = `${idPrefix}-${leg}`;
    legs.push({ externalPositionId });
    actions.push({ type: 'open', side, leg, externalPositionId });
  }
  return { actions, nextState: { side, entryPrice: price, legs, runner: null } };
}

function planPrice(state, price) {
  if (!state || !state.runner) {
    return ignored(state, 'no runner is open');
  }
  const runner = state.runner;
  const { side } = runner;

  // Stop already set: a price that reaches it closes the runner.
  if (runner.stop !== null) {
    const hit = side === 'buy' ? price <= runner.stop : price >= runner.stop;
    if (hit) {
      return {
        actions: [{ type: 'close', externalPositionId: runner.externalPositionId, side }],
        nextState: null
      };
    }
  }

  const best = moreFavorable(side, runner.best, price);
  let stop = runner.stop;
  if (profitDistance(side, runner.entryPrice, best) >= RUNNER_ACTIVATE_DISTANCE) {
    const candidate = side === 'buy' ? best - RUNNER_TRAIL_DISTANCE : best + RUNNER_TRAIL_DISTANCE;
    stop = stop === null ? candidate : moreFavorable(side, stop, candidate);
  }

  const nextState = { ...state, runner: { ...runner, best, stop } };
  if (stop !== null && stop !== runner.stop) {
    return {
      actions: [{ type: 'modify', externalPositionId: runner.externalPositionId, side, sl: stop }],
      nextState
    };
  }
  return { actions: [], nextState, ignored: 'price noted, no change' };
}

// Rebuilds state after a restart from the still-open tv positions saved in the
// database (latest event per position id). runnerEntryPrice is the price of the
// runner's original position_opened event, needed only when one position is left.
function rebuildState(openEvents, runnerEntryPrice) {
  if (openEvents.length === 0) {
    return null;
  }
  const sorted = [...openEvents].sort((a, b) => a.externalPositionId.localeCompare(b.externalPositionId));

  if (sorted.length === 1) {
    const only = sorted[0];
    const side = only.side;
    const entryPrice = runnerEntryPrice;
    let stop = null;
    let best = entryPrice;
    if (only.eventType === 'position_modified' && only.sl !== null) {
      stop = only.sl;
      best = side === 'buy' ? stop + RUNNER_TRAIL_DISTANCE : stop - RUNNER_TRAIL_DISTANCE;
    }
    return {
      side,
      entryPrice,
      legs: [],
      runner: { externalPositionId: only.externalPositionId, side, entryPrice, best, stop }
    };
  }

  return {
    side: sorted[0].side,
    entryPrice: sorted[0].price,
    legs: sorted.map((e) => ({ externalPositionId: e.externalPositionId })),
    runner: null
  };
}

function validateSignalPayload(body) {
  if (!body || typeof body !== 'object') {
    return 'JSON body is required.';
  }
  if (!body.token || typeof body.token !== 'string') {
    return 'token is required (the webhook token of your master account).';
  }
  const isPrice = body.signal === 'PRICE';
  if (!isPrice && !SIGNAL_SIDES[body.signal]) {
    return `signal must be one of: ${[...Object.keys(SIGNAL_SIDES), 'PRICE'].join(', ')}.`;
  }
  if (!body.symbol || typeof body.symbol !== 'string') {
    return 'symbol is required.';
  }
  const price = Number(body.price);
  if (body.price === undefined || body.price === null || !Number.isFinite(price) || price <= 0) {
    return 'price must be a positive number.';
  }
  if (!isPrice) {
    const size = Number(body.size);
    if (!Number.isFinite(size) || size <= 0) {
      return 'size must be a positive number.';
    }
  }
  return null;
}

module.exports = {
  SIGNAL_SIDES,
  LEGS_PER_SIGNAL,
  RUNNER_ACTIVATE_DISTANCE,
  RUNNER_TRAIL_DISTANCE,
  planEntry,
  planPrice,
  rebuildState,
  validateSignalPayload
};
