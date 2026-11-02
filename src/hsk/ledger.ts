import { hskStatePath, JsonStateStore } from './state';

export interface LedgerFill {
  id: string;
  timestamp: number;
  asset: string;
  side: 'buy' | 'sell';
  quantity: number;
  priceUsd: number;
  feeUsd: number;
  transactionHash?: string;
  strategyId?: string;
  realizedPnlUsd?: number;
}

export interface LedgerPosition {
  asset: string;
  quantity: number;
  averageCostUsd: number;
  realizedPnlUsd: number;
  updatedAt: number;
}

export interface LedgerSwap {
  transactionHash: string;
  blockNumber?: number;
  timestamp: number;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  strategyId?: string;
}

type LedgerState = { version: 1; fills: LedgerFill[]; swaps: LedgerSwap[]; positions: Record<string, LedgerPosition> };

export class TradingLedger {
  private state: LedgerState;
  private readonly store: JsonStateStore<LedgerState>;

  constructor(path = hskStatePath('ledger.json')) {
    this.store = new JsonStateStore(path, () => ({ version: 1, fills: [], swaps: [], positions: {} }));
    this.state = this.store.load();
    this.state.swaps ||= [];
  }

  recordSwap(swap: Omit<LedgerSwap, 'timestamp'> & Partial<Pick<LedgerSwap, 'timestamp'>>): LedgerSwap {
    const item = { ...swap, timestamp: swap.timestamp || Date.now() };
    if (!item.transactionHash || !item.tokenIn || !item.tokenOut) throw new Error('Swap record requires hash and token addresses');
    if (!this.state.swaps.some(existing => existing.transactionHash === item.transactionHash)) {
      this.state.swaps.push(item);
      this.store.save(this.state);
    }
    return item;
  }

  recordFill(fill: Omit<LedgerFill, 'id' | 'timestamp'> & Partial<Pick<LedgerFill, 'id' | 'timestamp'>>): LedgerFill {
    if (!Number.isFinite(fill.quantity) || fill.quantity <= 0) throw new Error('Fill quantity must be positive');
    if (!Number.isFinite(fill.priceUsd) || fill.priceUsd < 0) throw new Error('Fill USD price must be non-negative');
    const item: LedgerFill = {
      ...fill,
      id: fill.id || `${Date.now()}-${this.state.fills.length + 1}`,
      timestamp: fill.timestamp || Date.now(),
      feeUsd: Number.isFinite(fill.feeUsd) ? Math.max(0, fill.feeUsd) : 0,
      asset: fill.asset.toUpperCase(),
    };
    const current = this.state.positions[item.asset] || {
      asset: item.asset, quantity: 0, averageCostUsd: 0, realizedPnlUsd: 0, updatedAt: item.timestamp,
    };
    if (item.side === 'buy') {
      const oldCost = current.quantity * current.averageCostUsd;
      current.quantity += item.quantity;
      current.averageCostUsd = current.quantity > 0 ? (oldCost + item.quantity * item.priceUsd + item.feeUsd) / current.quantity : 0;
    } else {
      if (item.quantity > current.quantity + Number.EPSILON) throw new Error(`Insufficient ${item.asset} position for sell fill`);
      item.realizedPnlUsd = (item.priceUsd - current.averageCostUsd) * item.quantity - item.feeUsd;
      current.realizedPnlUsd += item.realizedPnlUsd;
      current.quantity = Math.max(0, current.quantity - item.quantity);
      if (current.quantity === 0) current.averageCostUsd = 0;
    }
    current.updatedAt = item.timestamp;
    this.state.fills.push(item);
    this.state.positions[item.asset] = current;
    this.store.save(this.state);
    return item;
  }

  getPosition(asset: string): LedgerPosition | undefined { return this.state.positions[asset.toUpperCase()]; }
  getDailyRealizedPnlUsd(now = Date.now()): number {
    const start = new Date(now); start.setUTCHours(0, 0, 0, 0);
    return this.state.fills.filter(item => item.timestamp >= start.getTime()).reduce((sum, item) => sum + (item.realizedPnlUsd || 0), 0);
  }

  getPortfolio(markPricesUsd: Record<string, number> = {}) {
    const positions = Object.values(this.state.positions).map(position => {
      const markPriceUsd = markPricesUsd[position.asset] ?? null;
      const marketValueUsd = markPriceUsd === null ? null : position.quantity * markPriceUsd;
      const unrealizedPnlUsd = markPriceUsd === null ? null : (markPriceUsd - position.averageCostUsd) * position.quantity;
      return { ...position, markPriceUsd, marketValueUsd, unrealizedPnlUsd };
    });
    const realizedPnlUsd = positions.reduce((sum, item) => sum + item.realizedPnlUsd, 0);
    const knownMarketValueUsd = positions.reduce((sum, item) => sum + (item.marketValueUsd || 0), 0);
    const knownUnrealizedPnlUsd = positions.reduce((sum, item) => sum + (item.unrealizedPnlUsd || 0), 0);
    return { positions, fills: this.state.fills.slice(-100), swaps: this.state.swaps.slice(-100), realizedPnlUsd, knownMarketValueUsd, knownUnrealizedPnlUsd };
  }
}

