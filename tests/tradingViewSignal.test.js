const test = require('node:test');
const assert = require('node:assert');
const {
  planEntry,
  planPrice,
  rebuildState,
  validateSignalPayload,
  RUNNER_ACTIVATE_DISTANCE,
  RUNNER_TRAIL_DISTANCE
} = require('../src/services/tradingViewSignalService');

const pair = (side = 'buy', entryPrice = 3000) => ({
  side,
  entryPrice,
  legs: [{ externalPositionId: 'tv-X-1-1' }, { externalPositionId: 'tv-X-1-2' }],
  runner: null
});

const runnerState = (runner = {}, side = 'buy') => ({
  side,
  entryPrice: 3000,
  legs: [],
  runner: { externalPositionId: 'tv-X-1-2', side, entryPrice: 3000, best: 3000, stop: null, ...runner }
});

test('uses a 100 activation distance and a 10 trail by default', () => {
  assert.strictEqual(RUNNER_ACTIVATE_DISTANCE, 100);
  assert.strictEqual(RUNNER_TRAIL_DISTANCE, 10);
});

test('opens two positions when nothing is open', () => {
  const plan = planEntry(null, 'buy', 3000, 'tv-X-1');
  assert.deepStrictEqual(plan.actions, [
    { type: 'open', side: 'buy', leg: 1, externalPositionId: 'tv-X-1-1' },
    { type: 'open', side: 'buy', leg: 2, externalPositionId: 'tv-X-1-2' }
  ]);
  assert.strictEqual(plan.nextState.entryPrice, 3000);
});

test('ignores a signal on the same side (BUY and LS_UP on one candle open once)', () => {
  assert.deepStrictEqual(planEntry(pair(), 'buy', 3001, 'tv-X-2').actions, []);
});

test('an opposite signal closes leg 1 only and leaves leg 2 as the runner', () => {
  const plan = planEntry(pair(), 'sell', 3020, 'tv-X-2');
  assert.deepStrictEqual(plan.actions, [{ type: 'close', externalPositionId: 'tv-X-1-1', side: 'buy' }]);
  assert.deepStrictEqual(plan.nextState.runner, {
    externalPositionId: 'tv-X-1-2',
    side: 'buy',
    entryPrice: 3000,
    best: 3020,
    stop: null
  });
});

test('no new entries while a runner is open', () => {
  assert.deepStrictEqual(planEntry(runnerState(), 'sell', 3000, 'tv-X-3').actions, []);
  assert.deepStrictEqual(planEntry(runnerState(), 'buy', 3000, 'tv-X-3').actions, []);
});

test('runner has no stop before it is 100 in profit', () => {
  const plan = planPrice(runnerState(), 3099);
  assert.deepStrictEqual(plan.actions, []);
  assert.strictEqual(plan.nextState.runner.stop, null);
  assert.strictEqual(plan.nextState.runner.best, 3099);
});

test('a pullback before activation does not close the runner', () => {
  assert.deepStrictEqual(planPrice(runnerState({ best: 3090 }), 2950).actions, []);
});

test('at +100 a stop is set 10 behind the best price', () => {
  const plan = planPrice(runnerState({ best: 3099 }), 3100);
  assert.deepStrictEqual(plan.actions, [
    { type: 'modify', externalPositionId: 'tv-X-1-2', side: 'buy', sl: 3090 }
  ]);
  assert.strictEqual(plan.nextState.runner.stop, 3090);
});

test("the stop only moves in the runner's favour", () => {
  const up = planPrice(runnerState({ best: 3100, stop: 3090 }), 3120);
  assert.strictEqual(up.nextState.runner.stop, 3110);
  const pullback = planPrice(runnerState({ best: 3120, stop: 3110 }), 3115);
  assert.deepStrictEqual(pullback.actions, []);
  assert.strictEqual(pullback.nextState.runner.stop, 3110);
});

test('price reaching the stop closes the runner and clears the state', () => {
  const plan = planPrice(runnerState({ best: 3120, stop: 3110 }), 3110);
  assert.deepStrictEqual(plan.actions, [{ type: 'close', externalPositionId: 'tv-X-1-2', side: 'buy' }]);
  assert.strictEqual(plan.nextState, null);
});

test('a sell runner works the mirror way', () => {
  const set = planPrice(runnerState({ best: 2901 }, 'sell'), 2900);
  assert.deepStrictEqual(set.actions, [{ type: 'modify', externalPositionId: 'tv-X-1-2', side: 'sell', sl: 2910 }]);
  const hit = planPrice(set.nextState, 2910);
  assert.deepStrictEqual(hit.actions, [{ type: 'close', externalPositionId: 'tv-X-1-2', side: 'sell' }]);
});

test('PRICE alerts are ignored when no runner is open', () => {
  assert.deepStrictEqual(planPrice(null, 3000).actions, []);
  assert.deepStrictEqual(planPrice(pair(), 3200).actions, []);
});

test('a new entry is allowed again once the runner has closed', () => {
  const closed = planPrice(runnerState({ best: 3120, stop: 3110 }), 3105);
  assert.strictEqual(closed.nextState, null);
  assert.strictEqual(planEntry(closed.nextState, 'sell', 3105, 'tv-X-4').actions.length, 2);
});

test('rebuilds state after a restart', () => {
  assert.strictEqual(rebuildState([], null), null);

  const twoOpen = rebuildState([
    { externalPositionId: 'tv-X-1-2', side: 'buy', price: 3000, eventType: 'position_opened', sl: null },
    { externalPositionId: 'tv-X-1-1', side: 'buy', price: 3000, eventType: 'position_opened', sl: null }
  ], null);
  assert.deepStrictEqual(twoOpen.legs.map((l) => l.externalPositionId), ['tv-X-1-1', 'tv-X-1-2']);
  assert.strictEqual(twoOpen.runner, null);

  const runner = rebuildState([
    { externalPositionId: 'tv-X-1-2', side: 'buy', price: 3115, eventType: 'position_modified', sl: 3110 }
  ], 3000);
  assert.deepStrictEqual(runner.runner, {
    externalPositionId: 'tv-X-1-2', side: 'buy', entryPrice: 3000, best: 3120, stop: 3110
  });
});

test('validates the alert payload', () => {
  const ok = { token: 't', signal: 'LS_UP', symbol: 'XAUUSD', size: 0.01, price: 3880.1 };
  assert.strictEqual(validateSignalPayload(ok), null);
  assert.strictEqual(validateSignalPayload({ token: 't', signal: 'PRICE', symbol: 'XAUUSD', price: 3880 }), null);
  assert.match(validateSignalPayload({ ...ok, signal: 'HOLD' }), /signal must be one of/);
  assert.match(validateSignalPayload({ ...ok, size: 0 }), /size/);
  assert.match(validateSignalPayload({ ...ok, price: undefined }), /price/);
  assert.match(validateSignalPayload({ ...ok, token: undefined }), /token/);
  assert.match(validateSignalPayload({ ...ok, symbol: '' }), /symbol/);
});
