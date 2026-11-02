import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Interface, type Log } from 'ethers';
import { HskMarketIndexer } from '../../src/hsk/market';

test('HSKSwap indexer checkpoints swap events and builds minute candles', async () => {
  const pool = '0x0000000000000000000000000000000000000001';
  const pool2 = '0x0000000000000000000000000000000000000004';
  const iface = new Interface(['event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)']);
  const encoded = iface.encodeEventLog(iface.getEvent('Swap')!, [
    '0x0000000000000000000000000000000000000002',
    '0x0000000000000000000000000000000000000003',
    100n, -200n, 2n ** 96n, 1_000n, 0,
  ]);
  const log = {
    address: pool, blockNumber: 100, transactionHash: '0xabc', index: 0,
    data: encoded.data, topics: encoded.topics, blockHash: '0xblock', transactionIndex: 0, removed: false,
  } as unknown as Log;
  const encoded2 = iface.encodeEventLog(iface.getEvent('Swap')!, [
    '0x0000000000000000000000000000000000000002',
    '0x0000000000000000000000000000000000000003',
    100n, -200n, BigInt(Math.floor(1.1 * 2 ** 96)), 1_000n, 0,
  ]);
  const log2 = { ...log, address: pool2, transactionHash: '0xdef', index: 1, data: encoded2.data, topics: encoded2.topics } as unknown as Log;
  let calls = 0;
  const provider = {
    async getBlockNumber() { return 100; },
    async getLogs() { calls++; return [log, log2]; },
    async getBlock() { return { timestamp: 1_700_000_001 }; },
  };
  const path = join(mkdtempSync(join(tmpdir(), 'clodds-market-')), 'market.json');
  const indexer = new HskMarketIndexer(provider, [pool, pool2], path, 0);
  const result = await indexer.pollOnce();
  assert.equal(result.indexed, 2);
  assert.equal(calls, 1);
  assert.equal(indexer.getCandles(pool).length, 1);
  assert.equal(indexer.getCandles(pool)[0].close, 1);
  const opportunities = indexer.detectPriceSpreads({ 'WHSK/USDT': [pool, pool2] }, 10, 100, 300, 1_700_000_100);
  assert.equal(opportunities.length, 1);
  assert.ok(opportunities[0].estimatedNetSpreadBps > 1_900);
  const restored = new HskMarketIndexer(provider, [pool, pool2], path, 0);
  assert.equal(restored.getStatus().lastBlock, 100);
  assert.equal((await restored.pollOnce()).indexed, 0);
});

