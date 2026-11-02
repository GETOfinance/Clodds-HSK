import assert from 'node:assert/strict';
import test from 'node:test';
import type { StrategyConfig } from '../../src/hsk/automation';
import { getTradingMode, tradingModeEnv, validateTradingMode } from '../../src/hsk/trading-mode';

const tokenIn = '0x1111111111111111111111111111111111111111';
const tokenOut = '0x2222222222222222222222222222222222222222';
const pool = '0x3333333333333333333333333333333333333333';
const completeEnv: NodeJS.ProcessEnv = {
  OPENROUTER_API_KEY: 'test-key',
  HSK_PRIVATE_KEY: `0x${'ab'.repeat(32)}`,
  HSK_MARK_PRICES_USD: JSON.stringify({ [tokenIn]: 1, [tokenOut]: 2 }),
  HSK_PORTFOLIO_VALUE_USD: '10000',
  HSK_ASSET_ALLOWLIST: `${tokenIn},${tokenOut}`,
  HSK_POOL_ADDRESSES: pool,
};
const strategy: StrategyConfig = {
  id: 'live-test', enabled: true, live: true, intervalMs: 60_000,
  tokenIn, tokenOut, amountIn: '1', pool, fee: 3000, slippageBps: 50,
  minConfidence: 0.5, maxPositionPct: 5, maxDailyLossPct: 2,
  stopLossPct: 3, assetAllowlist: [tokenIn, tokenOut], updatedAt: Date.now(),
};

test('trading mode flags map to the three UI states', () => {
  assert.equal(getTradingMode({}), 'dry-run');
  assert.equal(getTradingMode({ HSK_LIVE_TRADING: 'true' }), 'user');
  assert.equal(getTradingMode({ HSK_LIVE_TRADING: 'true', HSK_AUTONOMOUS_TRADING: 'true' }), 'autonomous');
  assert.deepEqual(tradingModeEnv('dry-run'), { HSK_LIVE_TRADING: 'false', HSK_AUTONOMOUS_TRADING: 'false' });
  assert.deepEqual(tradingModeEnv('user'), { HSK_LIVE_TRADING: 'true', HSK_AUTONOMOUS_TRADING: 'false' });
  assert.deepEqual(tradingModeEnv('autonomous'), { HSK_LIVE_TRADING: 'true', HSK_AUTONOMOUS_TRADING: 'true' });
});

test('dry-run is always available and user trading fails closed without prerequisites', () => {
  assert.equal(validateTradingMode('dry-run', { env: {} }).ready, true);
  const result = validateTradingMode('user', { env: {} });
  assert.equal(result.ready, false);
  assert.deepEqual(result.missing.map(item => item.key), [
    'OPENROUTER_API_KEY', 'HSK_PRIVATE_KEY', 'HSK_MARK_PRICES_USD',
    'HSK_PORTFOLIO_VALUE_USD', 'HSK_ASSET_ALLOWLIST',
  ]);
});

test('user trading activates with credentials, prices, valuation and allowlist', () => {
  const result = validateTradingMode('user', { env: completeEnv });
  assert.equal(result.ready, true);
  assert.match(result.allowancePolicy, /checked and approved/);
  const partialPrices = validateTradingMode('user', { env: { ...completeEnv, HSK_MARK_PRICES_USD: JSON.stringify({ [tokenIn]: 1 }) } });
  assert.equal(partialPrices.ready, false);
  assert.ok(partialPrices.missing.some(item => item.key === 'HSK_MARK_PRICES_USD'));
});

test('autonomous trading requires indexed pools, a live strategy and open kill switches', () => {
  const missingStrategy = validateTradingMode('autonomous', { env: completeEnv });
  assert.equal(missingStrategy.ready, false);
  assert.ok(missingStrategy.missing.some(item => item.key === 'LIVE_STRATEGY'));

  const killed = validateTradingMode('autonomous', { env: completeEnv, strategies: [strategy], strategyKillSwitch: true });
  assert.equal(killed.ready, false);
  assert.ok(killed.missing.some(item => item.key === 'STRATEGY_KILL_SWITCH'));

  const ready = validateTradingMode('autonomous', { env: completeEnv, strategies: [strategy] });
  assert.equal(ready.ready, true);
});
