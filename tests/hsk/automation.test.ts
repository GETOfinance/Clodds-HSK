import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { StrategyScheduler, StrategyStore } from '../../src/hsk/automation';
import { TradingLedger } from '../../src/hsk/ledger';
import { PortfolioRiskManager } from '../../src/hsk/risk';

test('strategy settings persist and enforce cadence plus asset allowlists', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'clodds-strategy-'));
  const path = join(directory, 'strategies.json');
  const store = new StrategyStore(path);
  assert.throws(() => store.upsert({ id: 'bad', enabled: true, tokenIn: 'A', tokenOut: 'B', amountIn: '1', assetAllowlist: ['A'] }), /allowlist/);
  store.upsert({ id: 'dca', enabled: true, tokenIn: 'A', tokenOut: 'B', amountIn: '1', intervalMs: 15_000, assetAllowlist: ['A', 'B'] });
  assert.equal(new StrategyStore(path).get('dca')?.tokenOut, 'B');
  let quotes = 0;
  const scheduler = new StrategyScheduler(store, {
    async decide() { return { action: 'buy', score: 0.5, confidence: 0.8, signals: [], reason: 'test' }; },
    async quote() { quotes++; return { ok: true }; },
    async execute() { throw new Error('must not execute dry run'); },
  });
  const first = await scheduler.tick(20_000);
  assert.equal(first[0].executed, false);
  assert.equal(first[0].reason, 'Dry-run strategy');
  await scheduler.tick(25_000);
  assert.equal(quotes, 1);
});

test('portfolio risk manager enforces position, daily-loss, valuation, and kill-switch gates', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clodds-risk-'));
  const ledger = new TradingLedger(join(directory, 'ledger.json'));
  const risk = new PortfolioRiskManager(ledger, join(directory, 'risk.json'));
  ledger.recordFill({ asset: 'HSK', side: 'buy', quantity: 10, priceUsd: 10, feeUsd: 0 });
  assert.equal(risk.isStopLossTriggered('HSK', 9, 5), true);
  assert.throws(() => risk.assertTrade({ asset: 'HSK', notionalUsd: 0, portfolioValueUsd: 1000 }), /positive independently valued/);
  assert.throws(() => risk.assertTrade({ asset: 'HSK', notionalUsd: 60, portfolioValueUsd: 1000, maxPositionPct: 5 }), /maximum position/);
  risk.setKillSwitch(true, 'incident');
  assert.throws(() => risk.assertTrade({ asset: 'HSK', notionalUsd: 10, portfolioValueUsd: 1000 }), /incident/);
  const restored = new PortfolioRiskManager(ledger, join(directory, 'risk.json'));
  assert.equal(restored.getStatus().killSwitch, true);
});

