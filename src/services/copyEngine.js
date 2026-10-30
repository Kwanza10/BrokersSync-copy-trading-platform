const brokerAccountService = require('./brokerAccountService');
const copyRelationshipService = require('./copyRelationshipService');
const symbolMappingService = require('./symbolMappingService');
const tradeEventService = require('./tradeEventService');
const copyExecutionService = require('./copyExecutionService');
const tradeLockerService = require('./tradeLockerService');
const mtBridgeService = require('./mtBridgeService');

const MT_PLATFORMS = ['mt4', 'mt5'];

// MT4/5 have no cloud API - an EA polls mtBridgeService's queue instead of
// this call executing anything directly, so the execution is left 'pending'
// here and only gets finalized (executed/failed) later, when the EA acks
// the command via POST /api/bridge/commands/:id/ack.
async function dispatchToMtBridge({ execution, commandType, followerAccountRow, symbol, side, size, sl, tp, targetPositionId }) {
  try {
    await mtBridgeService.createCommand({
      executionId: execution.id,
      followerAccountId: followerAccountRow.id,
      commandType,
      symbol,
      side,
      size,
      sl,
      tp,
      targetPositionId
    });
  } catch (error) {
    await copyExecutionService.markFailed(execution.id, `Failed to queue bridge command: ${error.message}`);
  }
}

// Simplified, documented approximation of USD value per 1.0 standard lot,
// used only for the percent_of_balance risk mode's sizing formula
// (riskAmount / pipValue, per spec). Ignores live conversion rates, JPY-pair
// pip sizing, and stop-loss distance - a real implementation should source
// per-instrument pip value from the broker rather than this static table.
const APPROX_USD_VALUE_PER_LOT = {
  XAUUSD: 100,
  US30: 10,
  NAS100: 20,
  DEFAULT: 10
};

function pipValueFor(symbol) {
  return APPROX_USD_VALUE_PER_LOT[String(symbol).toUpperCase()] || APPROX_USD_VALUE_PER_LOT.DEFAULT;
}

function calculateFollowerSize({ riskMode, riskValue, masterSize, followerBalance, symbol }) {
  switch (riskMode) {
    case 'fixed_lot':
      return riskValue;
    case 'percent_of_master':
      return Number((Number(masterSize || 0) * (riskValue / 100)).toFixed(2));
    case 'percent_of_balance': {
      const riskAmount = followerBalance * (riskValue / 100);
      return Number((riskAmount / pipValueFor(symbol)).toFixed(2));
    }
    default:
      throw new Error(`Unknown riskMode "${riskMode}".`);
  }
}

// TradingView entries open two same-side legs. On a netting account the broker
// merges them into one position, so closing leg 1 must close only leg 1's size
// or it would also wipe out leg 2 (the runner). Every other close, including
// the runner itself (leg 2) and every non-TradingView master, closes in full (0).
function closeQtyFor(externalPositionId, priorExecution) {
  const isTradingViewFirstLeg = /^tv-.+-1$/.test(String(externalPositionId || ''));
  return isTradingViewFirstLeg && priorExecution.calculatedSize > 0 ? priorExecution.calculatedSize : 0;
}

async function dispatchExecution({ execution, tradeEvent, followerAccountRow, masterAccountRow, mappedSymbol }) {
  if (tradeEvent.eventType === 'position_modified') {
    // Modify the follower's *existing* position in place - never place a new
    // order here. Find it the same way position_closed does: via the
    // original position_opened event for this master position, then the
    // executed copy of that event for this follower.
    const openEvent = tradeEvent.externalPositionId
      ? await tradeEventService.findOpenEventByExternalId(masterAccountRow.id, tradeEvent.externalPositionId)
      : null;
    const priorExecution = openEvent
      ? await copyExecutionService.findExecutedForTradeEvent(openEvent.id, followerAccountRow.id)
      : null;

    if (!priorExecution || !priorExecution.resultPositionId) {
      await copyExecutionService.markSkipped(execution.id, 'No matching open follower position found to modify.');
      return;
    }

    if (MT_PLATFORMS.includes(followerAccountRow.platform)) {
      await dispatchToMtBridge({
        execution,
        commandType: 'modify',
        followerAccountRow,
        sl: tradeEvent.sl,
        tp: tradeEvent.tp,
        targetPositionId: priorExecution.resultPositionId
      });
      return;
    }

    if (followerAccountRow.platform !== 'tradelocker') {
      const message = `Stub: ${followerAccountRow.platform} bridge not yet built - would update SL/TP on follower position ${priorExecution.resultPositionId}.`;
      console.log(`[copyEngine] STUB ${followerAccountRow.platform}: ${message}`);
      await copyExecutionService.markSkipped(execution.id, message);
      return;
    }

    try {
      const credentials = brokerAccountService.getDecryptedCredentials(followerAccountRow);
      const session = await tradeLockerService.authenticate(credentials, followerAccountRow.environment);
      await tradeLockerService.modifyPosition(session, {
        accNum: credentials.accNum,
        positionId: priorExecution.resultPositionId,
        stopLoss: tradeEvent.sl,
        takeProfit: tradeEvent.tp
      });
      await copyExecutionService.markExecuted(execution.id, priorExecution.resultPositionId);
    } catch (error) {
      await copyExecutionService.markFailed(execution.id, error.message);
    }
    return;
  }

  if (MT_PLATFORMS.includes(followerAccountRow.platform)) {
    if (tradeEvent.eventType === 'position_closed') {
      const openEvent = tradeEvent.externalPositionId
        ? await tradeEventService.findOpenEventByExternalId(masterAccountRow.id, tradeEvent.externalPositionId)
        : null;
      const priorExecution = openEvent
        ? await copyExecutionService.findExecutedForTradeEvent(openEvent.id, followerAccountRow.id)
        : null;

      if (!priorExecution || !priorExecution.resultPositionId) {
        await copyExecutionService.markSkipped(execution.id, 'No matching open follower position found to close.');
        return;
      }

      await dispatchToMtBridge({
        execution,
        commandType: 'close',
        followerAccountRow,
        targetPositionId: priorExecution.resultPositionId
      });
      return;
    }

    await dispatchToMtBridge({
      execution,
      commandType: 'open',
      followerAccountRow,
      symbol: mappedSymbol,
      side: tradeEvent.side,
      size: execution.calculatedSize,
      sl: tradeEvent.sl,
      tp: tradeEvent.tp
    });
    return;
  }

  if (followerAccountRow.platform !== 'tradelocker') {
    const verb = tradeEvent.eventType === 'position_closed' ? 'close' : 'open';
    const message = `Stub: ${followerAccountRow.platform} bridge not yet built - would ${verb} ${mappedSymbol} ${execution.calculatedSize} lots on account ${followerAccountRow.id}.`;
    console.log(`[copyEngine] STUB ${followerAccountRow.platform}: ${message}`);
    await copyExecutionService.markSkipped(execution.id, message);
    return;
  }

  try {
    const credentials = brokerAccountService.getDecryptedCredentials(followerAccountRow);

    if (tradeEvent.eventType === 'position_closed') {
      const openEvent = tradeEvent.externalPositionId
        ? await tradeEventService.findOpenEventByExternalId(masterAccountRow.id, tradeEvent.externalPositionId)
        : null;
      const priorExecution = openEvent
        ? await copyExecutionService.findExecutedForTradeEvent(openEvent.id, followerAccountRow.id)
        : null;

      if (!priorExecution || !priorExecution.resultPositionId) {
        await copyExecutionService.markSkipped(execution.id, 'No matching open follower position found to close.');
        return;
      }

      const session = await tradeLockerService.authenticate(credentials, followerAccountRow.environment);
      await tradeLockerService.closePosition(session, {
        accNum: credentials.accNum,
        positionId: priorExecution.resultPositionId,
        qty: closeQtyFor(tradeEvent.externalPositionId, priorExecution)
      });
      await copyExecutionService.markExecuted(execution.id);
      return;
    }

    const order = await tradeLockerService.executeTrade({
      credentials,
      environment: followerAccountRow.environment,
      accountId: credentials.accountId,
      accNum: credentials.accNum,
      symbol: mappedSymbol,
      action: tradeEvent.side,
      size: execution.calculatedSize
    });

    const resultPositionId = order && (order.positionId || order.orderId || order.id);
    // Lets you check on a demo account which id TradeLocker really returns:
    // a real position id (positionId) or only an order id (orderId / id).
    const idSource = order && (order.positionId ? 'positionId' : order.orderId ? 'orderId' : order.id ? 'id' : 'none');
    console.log(`[copyEngine] TradeLocker order placed: follower=${followerAccountRow.id} ${mappedSymbol} ${tradeEvent.side} ${execution.calculatedSize} saved ${idSource}=${resultPositionId} (response fields: ${order ? Object.keys(order).join(', ') : 'none'})`);
    await copyExecutionService.markExecuted(execution.id, resultPositionId ? String(resultPositionId) : null);
  } catch (error) {
    await copyExecutionService.markFailed(execution.id, error.message);
  }
}

async function processRelationship({ relationship, tradeEvent, masterAccountRow }) {
  const followerAccountRow = await brokerAccountService.getBrokerAccountRowById(relationship.followerAccountId);
  if (!followerAccountRow || followerAccountRow.status !== 'active') {
    return;
  }

  const mappedSymbol = await symbolMappingService.resolveSymbol({
    userId: relationship.followerUserId,
    sourcePlatform: masterAccountRow.platform,
    sourceSymbol: tradeEvent.symbol,
    targetPlatform: followerAccountRow.platform
  });

  const calculatedSize = calculateFollowerSize({
    riskMode: relationship.riskMode,
    riskValue: relationship.riskValue,
    masterSize: tradeEvent.size,
    followerBalance: Number(followerAccountRow.balance),
    symbol: mappedSymbol
  });

  const execution = await copyExecutionService.createExecution({
    tradeEventId: tradeEvent.id,
    followerAccountId: followerAccountRow.id,
    calculatedSize,
    mappedSymbol
  });

  await dispatchExecution({ execution, tradeEvent, followerAccountRow, masterAccountRow, mappedSymbol });
}

// Single entry point for both the webhook receiver and the TradeLocker
// poller - callers must never branch on where the event came from.
async function processTradeEvent(input) {
  const tradeEvent = await tradeEventService.createTradeEvent(input);

  // Durable, DB-level dedup: catches a retried webhook delivery (or any
  // re-emitted event, from either source) before any follower fan-out or
  // real order placement happens - not just before it gets logged.
  if (tradeEvent.isDuplicate) {
    console.log(
      `[copyEngine] Duplicate trade event dropped: source=${tradeEvent.sourceAccountId} type=${tradeEvent.eventType} externalPositionId=${tradeEvent.externalPositionId}`
    );
    return tradeEvent;
  }

  await tradeEventService.updateStatus(tradeEvent.id, 'processing');

  try {
    const masterAccountRow = await brokerAccountService.getBrokerAccountRowById(tradeEvent.sourceAccountId);
    if (!masterAccountRow) {
      await tradeEventService.updateStatus(tradeEvent.id, 'failed');
      return tradeEvent;
    }

    const relationships = await copyRelationshipService.getActiveRelationshipsForMaster(masterAccountRow.id);

    await Promise.allSettled(
      relationships.map((relationship) => processRelationship({ relationship, tradeEvent, masterAccountRow }))
    );

    await tradeEventService.updateStatus(tradeEvent.id, 'completed');
  } catch (error) {
    console.error('[copyEngine] processTradeEvent failed:', error.message);
    await tradeEventService.updateStatus(tradeEvent.id, 'failed');
  }

  return tradeEvent;
}

module.exports = { processTradeEvent, calculateFollowerSize, closeQtyFor };
