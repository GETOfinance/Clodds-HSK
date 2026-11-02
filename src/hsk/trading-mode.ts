import type { StrategyConfig } from './automation';

export type TradingMode = 'dry-run' | 'user' | 'autonomous';

export interface TradingModeRequirement {
  key: string;
  label: string;
  reason: string;
}

export interface TradingModeContext {
  env?: NodeJS.ProcessEnv;
  strategies?: StrategyConfig[];
  strategyKillSwitch?: boolean;
  riskKillSwitch?: boolean;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

function list(raw: string | undefined): string[] {
  return (raw || '').split(',').map(item => item.trim()).filter(Boolean);
}

function positivePriceAssets(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return new Set(Object.entries(parsed)
      .filter(([asset, price]) => ADDRESS.test(asset) && Number.isFinite(Number(price)) && Number(price) > 0)
      .map(([asset]) => asset.toLowerCase()));
  } catch {
    return new Set();
  }
}

export function getTradingMode(env: NodeJS.ProcessEnv = process.env): TradingMode {
  if (env.HSK_LIVE_TRADING !== 'true') return 'dry-run';
  return env.HSK_AUTONOMOUS_TRADING === 'true' ? 'autonomous' : 'user';
}

export function tradingModeEnv(mode: TradingMode): Record<string, string> {
  if (mode === 'autonomous') return { HSK_LIVE_TRADING: 'true', HSK_AUTONOMOUS_TRADING: 'true' };
  if (mode === 'user') return { HSK_LIVE_TRADING: 'true', HSK_AUTONOMOUS_TRADING: 'false' };
  return { HSK_LIVE_TRADING: 'false', HSK_AUTONOMOUS_TRADING: 'false' };
}

export function validateTradingMode(mode: TradingMode, context: TradingModeContext = {}): {
  ready: boolean;
  missing: TradingModeRequirement[];
  allowancePolicy: string;
} {
  const env = context.env || process.env;
  const missing: TradingModeRequirement[] = [];
  const require = (condition: boolean, key: string, label: string, reason: string) => {
    if (!condition) missing.push({ key, label, reason });
  };

  if (mode !== 'dry-run') {
    const allowlist = list(env.HSK_ASSET_ALLOWLIST);
    const priceAssets = positivePriceAssets(env.HSK_MARK_PRICES_USD);
    const portfolioValue = Number(env.HSK_PORTFOLIO_VALUE_USD);
    require(Boolean(env.OPENROUTER_API_KEY?.trim()), 'OPENROUTER_API_KEY', 'OpenRouter API key', 'Required for the conversational trading agent');
    require(PRIVATE_KEY.test(env.HSK_PRIVATE_KEY || ''), 'HSK_PRIVATE_KEY', 'Dedicated wallet private key', 'Must be a 0x-prefixed 32-byte private key');
    require(priceAssets.size > 0 && allowlist.length > 0 && allowlist.every(asset => priceAssets.has(asset.toLowerCase())), 'HSK_MARK_PRICES_USD', 'Independent USD prices', 'Provide a positive JSON price for every allowlisted token address');
    require(Number.isFinite(portfolioValue) && portfolioValue > 0, 'HSK_PORTFOLIO_VALUE_USD', 'Portfolio value', 'A positive verified USD value is required by risk controls');
    require(allowlist.length >= 2 && allowlist.every(item => ADDRESS.test(item)), 'HSK_ASSET_ALLOWLIST', 'Asset allowlist', 'Provide at least two valid token addresses');
    require(!context.riskKillSwitch, 'RISK_KILL_SWITCH', 'Risk kill switch', 'Disable the persistent risk kill switch before live trading');
  }

  if (mode === 'autonomous') {
    const pools = list(env.HSK_POOL_ADDRESSES);
    require(pools.length > 0 && pools.every(item => ADDRESS.test(item)), 'HSK_POOL_ADDRESSES', 'HSKSwap pools', 'Provide at least one valid pool address for continuous indexing');
    const liveStrategies = (context.strategies || []).filter(strategy => strategy.enabled && strategy.live);
    require(liveStrategies.length > 0, 'LIVE_STRATEGY', 'Enabled live strategy', 'Create a strategy with enabled=true and live=true');
    require(liveStrategies.every(strategy => Boolean(strategy.pool) && pools.map(item => item.toLowerCase()).includes(String(strategy.pool).toLowerCase())), 'STRATEGY_POOL', 'Indexed strategy pools', 'Every enabled live strategy must select a configured indexed pool');
    require(!context.strategyKillSwitch, 'STRATEGY_KILL_SWITCH', 'Automation kill switch', 'Disable the persistent automation kill switch');
  }

  return {
    ready: missing.length === 0,
    missing,
    allowancePolicy: mode === 'dry-run' ? 'No approvals are submitted in dry-run mode' : 'ERC-20 allowance is checked and approved only when a validated swap executes',
  };
}
