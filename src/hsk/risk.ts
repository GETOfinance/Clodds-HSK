import type { TradingLedger } from './ledger';
import { hskStatePath, JsonStateStore } from './state';

type RiskState = { version: 1; killSwitch: boolean; reason?: string; updatedAt: number };
export interface TradeRiskInput {
  asset: string;
  notionalUsd: number;
  portfolioValueUsd: number;
  confidence?: number;
  allowedAssets?: string[];
  increasesExposure?: boolean;
  maxPositionPct?: number;
  maxDailyLossPct?: number;
  minConfidence?: number;
}

export class PortfolioRiskManager {
  private state: RiskState;
  private readonly store: JsonStateStore<RiskState>;
  constructor(private readonly ledger: TradingLedger, path = hskStatePath('risk.json')) {
    this.store = new JsonStateStore(path, () => ({ version: 1, killSwitch: false, updatedAt: Date.now() }));
    this.state = this.store.load();
  }
  getStatus() { return { ...this.state }; }
  setKillSwitch(enabled: boolean, reason = ''): void {
    this.state = { version: 1, killSwitch: enabled, reason: reason || undefined, updatedAt: Date.now() };
    this.store.save(this.state);
  }
  assertTrade(input: TradeRiskInput): void {
    if (this.state.killSwitch) throw new Error(`Portfolio kill switch is active${this.state.reason ? `: ${this.state.reason}` : ''}`);
    if (!Number.isFinite(input.notionalUsd) || input.notionalUsd <= 0) throw new Error('A positive independently valued USD notional is required for live trading');
    if (!Number.isFinite(input.portfolioValueUsd) || input.portfolioValueUsd <= 0) throw new Error('A positive portfolio valuation is required for live trading');
    const normalizedAsset = input.asset.toLowerCase();
    if (input.allowedAssets?.length && !input.allowedAssets.map(item => item.toLowerCase()).includes(normalizedAsset)) throw new Error('Target asset is not in the configured allowlist');
    const portfolio = this.ledger.getPortfolio();
    const dailyRealizedPnlUsd = this.ledger.getDailyRealizedPnlUsd();
    const maxDailyLossPct = input.maxDailyLossPct ?? Number(process.env.HSK_MAX_DAILY_LOSS_PCT || 2);
    if (dailyRealizedPnlUsd < 0 && Math.abs(dailyRealizedPnlUsd) / input.portfolioValueUsd * 100 >= maxDailyLossPct) {
      throw new Error(`Daily-loss limit reached (${maxDailyLossPct}%)`);
    }
    const minConfidence = input.minConfidence ?? Number(process.env.HSK_MIN_SIGNAL_CONFIDENCE || 0.45);
    if (input.confidence !== undefined && input.confidence < minConfidence) throw new Error(`Signal confidence is below ${minConfidence}`);
    if (input.increasesExposure !== false) {
      const maxPositionPct = input.maxPositionPct ?? Number(process.env.HSK_MAX_POSITION_PCT || 5);
      const positionPct = input.notionalUsd / input.portfolioValueUsd * 100;
      if (positionPct > maxPositionPct) throw new Error(`Trade would exceed the ${maxPositionPct}% maximum position limit`);
    }
  }
  isStopLossTriggered(asset: string, markPriceUsd: number, stopLossPct = Number(process.env.HSK_STOP_LOSS_PCT || 3)): boolean {
    const position = this.ledger.getPosition(asset);
    return Boolean(position && position.quantity > 0 && position.averageCostUsd > 0
      && markPriceUsd <= position.averageCostUsd * (1 - stopLossPct / 100));
  }
}

export function parseMarkPrices(raw = process.env.HSK_MARK_PRICES_USD): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).map(([asset, value]) => [asset.toLowerCase(), Number(value)] as [string, number]).filter(([, value]) => Number.isFinite(value) && value > 0));
  } catch {
    throw new Error('HSK_MARK_PRICES_USD must be valid JSON with positive numeric prices');
  }
}

export function calculateNotionalUsd(token: string, amount: string, decimals = 18, prices = parseMarkPrices()): number {
  const price = prices[token.toLowerCase()];
  if (!price) throw new Error(`Missing independent USD mark price for ${token}`);
  const numericAmount = Number(amount) / 10 ** decimals;
  return numericAmount * price;
}

