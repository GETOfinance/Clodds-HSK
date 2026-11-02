import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DurableSessionManager } from '../../src/hsk/session-store';
import { TradingLedger } from '../../src/hsk/ledger';

test('sessions survive a manager restart with bounded conversation history', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'clodds-session-')), 'sessions.json');
  const first = new DurableSessionManager(path);
  const session = first.create('user-1', 'webchat', 'chat-1');
  for (let index = 0; index < 35; index++) first.addToHistory(session, 'user', `message-${index}`);
  const second = new DurableSessionManager(path);
  const restored = second.getSessionById('chat-1');
  assert.ok(restored);
  assert.equal(restored.history.length, 35);
  assert.equal(restored.context.conversationHistory.length, 30);
  assert.equal(restored.context.conversationHistory[0].content, 'message-5');
  assert.ok(restored.updatedAt instanceof Date);
});

test('ledger persists cost basis and realized P&L', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'clodds-ledger-')), 'ledger.json');
  const ledger = new TradingLedger(path);
  ledger.recordFill({ asset: 'HSK', side: 'buy', quantity: 10, priceUsd: 1, feeUsd: 0 });
  ledger.recordFill({ asset: 'HSK', side: 'buy', quantity: 10, priceUsd: 3, feeUsd: 0 });
  ledger.recordFill({ asset: 'HSK', side: 'sell', quantity: 5, priceUsd: 4, feeUsd: 1 });
  ledger.recordSwap({ transactionHash: '0xabc', tokenIn: '0xin', tokenOut: '0xout', amountIn: '10', amountOut: '20' });
  const restored = new TradingLedger(path).getPortfolio({ HSK: 5 });
  assert.equal(restored.positions[0].quantity, 15);
  assert.equal(restored.positions[0].averageCostUsd, 2);
  assert.equal(restored.realizedPnlUsd, 9);
  assert.equal(restored.knownUnrealizedPnlUsd, 45);
  assert.equal(restored.swaps[0].transactionHash, '0xabc');
});

