import { id, Interface, type Log } from 'ethers';
import { hskStatePath, JsonStateStore } from './state';

export interface IndexedSwap {
  id: string;
  pool: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
  timestamp: number;
  price: number;
  amount0: string;
  amount1: string;
}

export interface MarketCandle {
  pool: string;
  startTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades: number;
}
export interface PriceSpreadOpportunity {
  pair: string;
  buyPool: string;
  sellPool: string;
  buyPrice: number;
  sellPrice: number;
  grossSpreadBps: number;
  estimatedNetSpreadBps: number;
  observedAt: number;
}

type MarketState = { version: 1; lastBlock: number; swaps: IndexedSwap[]; candles: MarketCandle[]; lastUpdatedAt: number };
export interface MarketProvider {
  getBlockNumber(): Promise<number>;
  getLogs(filter: { address: string[]; topics: string[]; fromBlock: number; toBlock: number }): Promise<Log[]>;
  getBlock(blockNumber: number): Promise<{ timestamp: number } | null>;
}

const SWAP_EVENT = 'Swap(address,address,int256,int256,uint160,uint128,int24)';
const SWAP_TOPIC = id(SWAP_EVENT);
const SWAP_INTERFACE = new Interface([
  'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
]);

function sqrtPriceToPrice(value: bigint): number {
  const ratio = Number(value) / 2 ** 96;
  return ratio * ratio;
}

export class HskMarketIndexer {
  private state: MarketState;
  private readonly store: JsonStateStore<MarketState>;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly provider: MarketProvider,
    readonly pools: string[],
    path = hskStatePath('market-index.json'),
    private readonly confirmations = 2,
    private readonly blockChunk = 1_000,
  ) {
    this.store = new JsonStateStore(path, () => ({ version: 1, lastBlock: 0, swaps: [], candles: [], lastUpdatedAt: 0 }));
    this.state = this.store.load();
  }

  async pollOnce(): Promise<{ indexed: number; lastBlock: number }> {
    if (this.pools.length === 0) return { indexed: 0, lastBlock: this.state.lastBlock };
    const chainTip = await this.provider.getBlockNumber();
    const safeTip = Math.max(0, chainTip - this.confirmations);
    if (safeTip <= this.state.lastBlock) return { indexed: 0, lastBlock: this.state.lastBlock };
    let fromBlock = this.state.lastBlock > 0 ? this.state.lastBlock + 1 : Math.max(0, safeTip - this.blockChunk + 1);
    let indexed = 0;
    while (fromBlock <= safeTip) {
      const toBlock = Math.min(safeTip, fromBlock + this.blockChunk - 1);
      const logs = await this.provider.getLogs({ address: this.pools, topics: [SWAP_TOPIC], fromBlock, toBlock });
      const blockTimes = new Map<number, number>();
      for (const log of logs) {
        const parsed = SWAP_INTERFACE.parseLog(log);
        if (!parsed) continue;
        let timestamp = blockTimes.get(log.blockNumber);
        if (timestamp === undefined) {
          timestamp = (await this.provider.getBlock(log.blockNumber))?.timestamp || Math.floor(Date.now() / 1000);
          blockTimes.set(log.blockNumber, timestamp);
        }
        const logIndex = log.index;
        const event: IndexedSwap = {
          id: `${log.transactionHash}:${logIndex}`,
          pool: log.address.toLowerCase(),
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash,
          logIndex,
          timestamp,
          price: sqrtPriceToPrice(parsed.args.sqrtPriceX96 as bigint),
          amount0: (parsed.args.amount0 as bigint).toString(),
          amount1: (parsed.args.amount1 as bigint).toString(),
        };
        if (!this.state.swaps.some(item => item.id === event.id)) {
          this.state.swaps.push(event);
          this.applyCandle(event);
          indexed++;
        }
      }
      this.state.lastBlock = toBlock;
      fromBlock = toBlock + 1;
    }
    this.state.swaps = this.state.swaps.slice(-20_000);
    this.state.candles = this.state.candles.slice(-20_000);
    this.state.lastUpdatedAt = Date.now();
    this.store.save(this.state);
    return { indexed, lastBlock: this.state.lastBlock };
  }

  private applyCandle(event: IndexedSwap): void {
    const startTime = Math.floor(event.timestamp / 60) * 60;
    const existing = this.state.candles.find(item => item.pool === event.pool && item.startTime === startTime);
    const volume = Math.abs(Number(event.amount0));
    if (existing) {
      existing.high = Math.max(existing.high, event.price);
      existing.low = Math.min(existing.low, event.price);
      existing.close = event.price;
      existing.volume += Number.isFinite(volume) ? volume : 0;
      existing.trades++;
    } else {
      this.state.candles.push({ pool: event.pool, startTime, open: event.price, high: event.price, low: event.price, close: event.price, volume: Number.isFinite(volume) ? volume : 0, trades: 1 });
    }
  }

  getCandles(pool?: string, limit = 500): MarketCandle[] {
    return this.state.candles.filter(item => !pool || item.pool === pool.toLowerCase()).slice(-limit);
  }
  detectPriceSpreads(groups: Record<string, string[]>, minNetSpreadBps = 10, estimatedCostsBps = 100, maxAgeSeconds = 300, nowSeconds = Math.floor(Date.now() / 1000)): PriceSpreadOpportunity[] {
    const opportunities: PriceSpreadOpportunity[] = [];
    for (const [pair, pools] of Object.entries(groups)) {
      const latest = pools.map(pool => this.state.candles.filter(item => item.pool === pool.toLowerCase()).at(-1))
        .filter((item): item is MarketCandle => Boolean(item && nowSeconds - item.startTime <= maxAgeSeconds));
      if (latest.length < 2) continue;
      const buy = latest.reduce((lowest, item) => item.close < lowest.close ? item : lowest);
      const sell = latest.reduce((highest, item) => item.close > highest.close ? item : highest);
      const grossSpreadBps = (sell.close - buy.close) / buy.close * 10_000;
      const estimatedNetSpreadBps = grossSpreadBps - estimatedCostsBps;
      if (estimatedNetSpreadBps >= minNetSpreadBps) opportunities.push({ pair, buyPool: buy.pool, sellPool: sell.pool, buyPrice: buy.close, sellPrice: sell.close, grossSpreadBps, estimatedNetSpreadBps, observedAt: Math.max(buy.startTime, sell.startTime) });
    }
    return opportunities.sort((a, b) => b.estimatedNetSpreadBps - a.estimatedNetSpreadBps);
  }
  getStatus() { return { pools: this.pools, lastBlock: this.state.lastBlock, lastUpdatedAt: this.state.lastUpdatedAt, swaps: this.state.swaps.length, candles: this.state.candles.length }; }
  start(intervalMs = 15_000): void { if (!this.timer) { void this.pollOnce(); this.timer = setInterval(() => void this.pollOnce(), intervalMs); this.timer.unref?.(); } }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}

export { SWAP_TOPIC };

