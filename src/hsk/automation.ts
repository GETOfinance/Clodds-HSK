import type { TradingDecision } from './index';
import { hskStatePath, JsonStateStore } from './state';

export interface StrategyConfig {
  id: string;
  enabled: boolean;
  intervalMs: number;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  pool?: string;
  fee: 100 | 500 | 3000 | 10000;
  slippageBps: number;
  minConfidence: number;
  maxPositionPct: number;
  maxDailyLossPct: number;
  stopLossPct: number;
  assetAllowlist: string[];
  live: boolean;
  updatedAt: number;
}
type StrategyState = { version: 1; strategies: StrategyConfig[]; killSwitch: boolean };

export class StrategyStore {
  private state: StrategyState;
  private readonly store: JsonStateStore<StrategyState>;
  constructor(path = hskStatePath('strategies.json')) {
    this.store = new JsonStateStore(path, () => ({ version: 1, strategies: [], killSwitch: false }));
    this.state = this.store.load();
  }
  list(): StrategyConfig[] { return this.state.strategies.map(item => ({ ...item, assetAllowlist: [...item.assetAllowlist] })); }
  get(id: string): StrategyConfig | undefined { return this.state.strategies.find(item => item.id === id); }
  isKilled(): boolean { return this.state.killSwitch; }
  setKillSwitch(enabled: boolean): void { this.state.killSwitch = enabled; this.store.save(this.state); }
  upsert(input: Partial<StrategyConfig> & { id: string }): StrategyConfig {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(input.id)) throw new Error('Strategy id must contain only letters, numbers, underscores, or dashes');
    const existing = this.get(input.id);
    const next: StrategyConfig = {
      id: input.id,
      enabled: input.enabled ?? existing?.enabled ?? false,
      intervalMs: input.intervalMs ?? existing?.intervalMs ?? 60_000,
      tokenIn: input.tokenIn ?? existing?.tokenIn ?? '',
      tokenOut: input.tokenOut ?? existing?.tokenOut ?? '',
      amountIn: input.amountIn ?? existing?.amountIn ?? '0',
      pool: input.pool ?? existing?.pool,
      fee: input.fee ?? existing?.fee ?? 3000,
      slippageBps: input.slippageBps ?? existing?.slippageBps ?? 50,
      minConfidence: input.minConfidence ?? existing?.minConfidence ?? 0.45,
      maxPositionPct: input.maxPositionPct ?? existing?.maxPositionPct ?? 5,
      maxDailyLossPct: input.maxDailyLossPct ?? existing?.maxDailyLossPct ?? 2,
      stopLossPct: input.stopLossPct ?? existing?.stopLossPct ?? 3,
      assetAllowlist: input.assetAllowlist ?? existing?.assetAllowlist ?? [],
      live: input.live ?? existing?.live ?? false,
      updatedAt: Date.now(),
    };
    if (next.intervalMs < 15_000) throw new Error('Strategy interval must be at least 15 seconds');
    if (next.slippageBps < 1 || next.slippageBps > 2_000) throw new Error('Strategy slippage must be between 1 and 2000 bps');
    if (next.minConfidence < 0 || next.minConfidence > 1) throw new Error('Minimum confidence must be between 0 and 1');
    if (next.maxPositionPct <= 0 || next.maxPositionPct > 100) throw new Error('Maximum position must be between 0 and 100 percent');
    if (next.maxDailyLossPct <= 0 || next.maxDailyLossPct > 100) throw new Error('Maximum daily loss must be between 0 and 100 percent');
    if (next.stopLossPct <= 0 || next.stopLossPct > 100) throw new Error('Stop loss must be between 0 and 100 percent');
    if (next.enabled && (!next.tokenIn || !next.tokenOut || Number(next.amountIn) <= 0)) throw new Error('Enabled strategies require tokens and a positive amount');
    const allowed = new Set(next.assetAllowlist.map(item => item.toLowerCase()));
    if (next.enabled && (!allowed.has(next.tokenIn.toLowerCase()) || !allowed.has(next.tokenOut.toLowerCase()))) throw new Error('Both strategy tokens must be in the asset allowlist');
    const index = this.state.strategies.findIndex(item => item.id === next.id);
    if (index >= 0) this.state.strategies[index] = next; else this.state.strategies.push(next);
    this.store.save(this.state);
    return next;
  }
}

export interface AutomationDependencies {
  decide(strategy: StrategyConfig): Promise<TradingDecision>;
  quote(strategy: StrategyConfig, decision: TradingDecision): Promise<unknown>;
  execute(strategy: StrategyConfig, decision: TradingDecision): Promise<unknown>;
  onResult?(result: AutomationRun): void;
}
export interface AutomationRun { strategyId: string; timestamp: number; action: string; executed: boolean; reason: string; result?: unknown }

export class StrategyScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private readonly lastRuns = new Map<string, number>();
  constructor(private readonly strategies: StrategyStore, private readonly dependencies: AutomationDependencies) {}

  async tick(now = Date.now()): Promise<AutomationRun[]> {
    const results: AutomationRun[] = [];
    for (const strategy of this.strategies.list().filter(item => item.enabled)) {
      const lastRun = this.lastRuns.get(strategy.id) || 0;
      if (now - lastRun < strategy.intervalMs) continue;
      this.lastRuns.set(strategy.id, now);
      let run: AutomationRun;
      try {
        if (this.strategies.isKilled()) throw new Error('Global kill switch is active');
        const decision = await this.dependencies.decide(strategy);
        if (decision.action === 'hold' || decision.confidence < strategy.minConfidence) {
          run = { strategyId: strategy.id, timestamp: now, action: decision.action, executed: false, reason: `Signal threshold not met (${decision.confidence.toFixed(3)})` };
        } else if (!strategy.live) {
          run = { strategyId: strategy.id, timestamp: now, action: decision.action, executed: false, reason: 'Dry-run strategy', result: await this.dependencies.quote(strategy, decision) };
        } else if (process.env.HSK_AUTONOMOUS_TRADING !== 'true' || process.env.HSK_LIVE_TRADING !== 'true') {
          throw new Error('Autonomous live trading requires HSK_AUTONOMOUS_TRADING=true and HSK_LIVE_TRADING=true');
        } else {
          run = { strategyId: strategy.id, timestamp: now, action: decision.action, executed: true, reason: 'Passed signal, allowlist, cadence, live-mode and kill-switch gates', result: await this.dependencies.execute(strategy, decision) };
        }
      } catch (error) {
        run = { strategyId: strategy.id, timestamp: now, action: 'blocked', executed: false, reason: error instanceof Error ? error.message : String(error) };
      }
      results.push(run);
      this.dependencies.onResult?.(run);
    }
    return results;
  }
  start(intervalMs = 5_000): void { if (!this.timer) { this.timer = setInterval(() => void this.tick(), intervalMs); this.timer.unref?.(); } }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}

