const test = require('node:test');
const assert = require('node:assert');
const { planActions, validateSignalPayload } = require('../src/services/tradingViewSignalService');

test('opens a position when nothing is open', () => {
  assert.deepStrictEqual(planActions(null, 'buy'), [{ type: 'open', side: 'buy' }]);
});

test('ignores a signal on the same side (BUY and LS_UP on one candle open once)', () => {
  assert.deepStrictEqual(planActions({ side: 'buy', externalPositionId: 'tv-X-1' }, 'buy'), []);
});

test('an opposite signal closes the open position, then opens the new side', () => {
  assert.deepStrictEqual(planActions({ side: 'buy', externalPositionId: 'tv-X-1' }, 'sell'), [
    { type: 'close', externalPositionId: 'tv-X-1', side: 'buy' },
    { type: 'open', side: 'sell' }
  ]);
});

test('validates the alert payload', () => {
  const ok = { token: 't', signal: 'LS_UP', symbol: 'XAUUSD', size: 0.01 };
  assert.strictEqual(validateSignalPayload(ok), null);
  assert.match(validateSignalPayload({ ...ok, signal: 'HOLD' }), /signal must be one of/);
  assert.match(validateSignalPayload({ ...ok, size: 0 }), /size/);
  assert.match(validateSignalPayload({ ...ok, token: undefined }), /token/);
  assert.match(validateSignalPayload({ ...ok, symbol: '' }), /symbol/);
});
