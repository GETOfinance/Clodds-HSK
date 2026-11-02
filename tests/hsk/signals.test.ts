import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeSixSignals, getHskAgentStatus, HSK_CHAIN } from '../../src/hsk';

test('HSK runtime is pinned to mainnet and dry-run by default', () => {
  const original = process.env.HSK_LIVE_TRADING;
  delete process.env.HSK_LIVE_TRADING;
  const status = getHskAgentStatus();
  assert.equal(HSK_CHAIN.id, 177);
  assert.equal(status.mode, 'dry-run');
  assert.equal(status.dex.name, 'HSKSwap');
  if (original === undefined) delete process.env.HSK_LIVE_TRADING;
  else process.env.HSK_LIVE_TRADING = original;
});

test('six-signal engine returns six bounded readings', () => {
  const candles = Array.from({ length: 40 }, (_, index) => ({
    close: 100 + index * 0.7 + Math.sin(index / 2),
    volume: 1_000 + index * 20,
  }));
  const decision = analyzeSixSignals({
    candles,
    orderBook: { bidVolume: 1_500, askVolume: 900 },
    sentiment: 0.4,
  });
  assert.equal(decision.signals.length, 6);
  assert.ok(decision.score >= -1 && decision.score <= 1);
  assert.ok(decision.confidence >= 0 && decision.confidence <= 1);
  for (const signal of decision.signals) assert.ok(signal.score >= -1 && signal.score <= 1);
});

test('six-signal engine rejects insufficient candle history', () => {
  assert.throws(() => analyzeSixSignals({ candles: [{ close: 1, volume: 1 }] }), /At least 20 candles/);
});
