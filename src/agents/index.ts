/** Dedicated HSKSwap agent. Legacy multi-venue trading code was removed. */
import Anthropic from '@anthropic-ai/sdk';
import type { Config, IncomingMessage, Session } from '../types';
import { withRetry, RETRY_POLICIES } from '../infra/retry';
import { logger } from '../utils/logger';
import { analyzeSixSignals, executeHskSwap, getHskAgentStatus, quoteHskSwap } from '../hsk';
import type { TradingLedger } from '../hsk/ledger';
import type { PortfolioRiskManager } from '../hsk/risk';
import type { StrategyStore } from '../hsk/automation';

export interface AgentManager {
  handleMessage(message: IncomingMessage, session: Session): Promise<string | null>;
  dispose(): void;
  reloadSkills(): void;
  reloadConfig(config: Config): void;
  getSkillCommands(): Array<{ name: string; description: string; subcommands?: Array<{ name: string; description: string; category: string }> }>;
}

interface SessionStore {
  getHistory(session: Session): Array<{ role: 'user' | 'assistant'; content: string }>;
  addToHistory(session: Session, role: 'user' | 'assistant', content: string): void;
}

export interface HskAgentServices {
  ledger: TradingLedger;
  strategies: StrategyStore;
  risk: PortfolioRiskManager;
  marketStatus?: () => unknown;
  marketOpportunities?: () => unknown;
  executeSwap?: (request: ReturnType<typeof swapRequest>, context: { currentText: string; strategyId?: string }) => Promise<unknown>;
}

const SYSTEM_PROMPT = `You are Clodds HSK, an autonomous but human-controlled AI trading agent.

Scope:
- HSK Chain Mainnet only: chain ID 177, native HSK, RPC https://mainnet.hsk.xyz.
- HSKSwap only: https://app.hskswap.com/.
- OpenRouter supplies the LLM.
- Decisions combine RSI, MACD, Bollinger Bands, Volume, Order Book imbalance, and Sentiment.

Rules:
- Default to dry-run analysis and quotes. Never imply guaranteed or sustained profit.
- Separate observed data from inference and state uncertainty.
- Show all six signal states, composite score, confidence, and risk checks when explaining a decision.
- Execute only when the current user message explicitly confirms that exact live trade.
- Unattended strategies are opt-in only and must pass cadence, asset-allowlist, signal-confidence, valuation, portfolio-risk, live-mode, and kill-switch gates.
- Enforce configured position, daily-loss, stop-loss, slippage, and confidence limits.
- Never request, display, or repeat seed phrases or private keys.
- Do not suggest or use another chain, exchange, prediction market, or DEX.
- Keep responses concise for WebChat, Telegram, WhatsApp, and other connected channels.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'hsk_agent_status',
    description: 'Return HSK Chain, HSKSwap, OpenRouter, signal, execution-mode, token, and risk configuration.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'hsk_analyze_signals',
    description: 'Combine six market signals into an explainable buy, hold, or sell decision. Requires at least 20 chronological candles.',
    input_schema: {
      type: 'object',
      properties: {
        candles: {
          type: 'array',
          description: 'Chronological candles with positive close and non-negative volume.',
          items: {
            type: 'object',
            properties: { close: { type: 'number' }, volume: { type: 'number' } },
            required: ['close', 'volume'],
          },
        },
        bid_volume: { type: 'number', description: 'Aggregated bid-side liquidity.' },
        ask_volume: { type: 'number', description: 'Aggregated ask-side liquidity.' },
        sentiment: { type: 'number', description: 'Normalized sentiment from -1 to 1.' },
      },
      required: ['candles'],
    },
  },
  {
    name: 'hsk_quote_swap',
    description: 'Get a read-only HSKSwap V3 exact-input quote. Never signs or submits a transaction.',
    input_schema: {
      type: 'object',
      properties: {
        token_in: { type: 'string' }, token_out: { type: 'string' }, amount_in: { type: 'string' },
        token_in_decimals: { type: 'number' }, token_out_decimals: { type: 'number' },
        fee: { type: 'number', enum: [100, 500, 3000, 10000] }, slippage_bps: { type: 'number' },
      },
      required: ['token_in', 'token_out', 'amount_in'],
    },
  },
  {
    name: 'hsk_execute_swap',
    description: 'Execute an ERC-20 exact-input swap on HSKSwap. Runtime checks live mode and current-message confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        token_in: { type: 'string' }, token_out: { type: 'string' }, amount_in: { type: 'string' },
        token_in_decimals: { type: 'number' }, token_out_decimals: { type: 'number' },
        fee: { type: 'number', enum: [100, 500, 3000, 10000] }, slippage_bps: { type: 'number' },
      },
      required: ['token_in', 'token_out', 'amount_in'],
    },
  },
  {
    name: 'hsk_portfolio',
    description: 'Return durable positions, fills, swap receipts, cost basis, and known realized/unrealized P&L.',
    input_schema: {
      type: 'object',
      properties: { mark_prices_usd: { type: 'object', description: 'Optional independently sourced USD marks keyed by asset symbol.' } },
    },
  },
  {
    name: 'hsk_strategies',
    description: 'List persistent automated-strategy settings, global kill-switch state, and market-indexer status.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'hsk_opportunities',
    description: 'Return fresh cross-pool HSKSwap price-spread opportunities after configured gas, fee, slippage, and failure-cost estimates.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'hsk_update_strategy',
    description: 'Create or update a persistent strategy. Strategies remain disabled/live=false unless explicitly requested, and both tokens must be allowlisted.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' }, enabled: { type: 'boolean' }, live: { type: 'boolean' }, interval_ms: { type: 'number' },
        token_in: { type: 'string' }, token_out: { type: 'string' }, amount_in: { type: 'string' }, pool: { type: 'string' },
        fee: { type: 'number', enum: [100, 500, 3000, 10000] }, slippage_bps: { type: 'number' }, min_confidence: { type: 'number' },
        max_position_pct: { type: 'number' }, max_daily_loss_pct: { type: 'number' }, stop_loss_pct: { type: 'number' },
        asset_allowlist: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
  },
  {
    name: 'hsk_set_kill_switch',
    description: 'Enable or disable the persistent portfolio and scheduler kill switch.',
    input_schema: { type: 'object', properties: { enabled: { type: 'boolean' }, reason: { type: 'string' } }, required: ['enabled'] },
  },
];

function createLlmClient(): Anthropic {
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  const apiKey = openRouterKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is required');
  if (!openRouterKey) return new Anthropic({ apiKey });
  return new Anthropic({
    apiKey,
    baseURL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api',
    defaultHeaders: {
      Authorization: `Bearer ${openRouterKey}`,
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:18789/webchat',
      'X-Title': process.env.OPENROUTER_APP_NAME || 'Clodds HSK AI Trading Agent',
    },
  });
}

function swapRequest(input: Record<string, unknown>) {
  return {
    tokenIn: String(input.token_in || ''), tokenOut: String(input.token_out || ''), amountIn: String(input.amount_in || ''),
    tokenInDecimals: input.token_in_decimals as number | undefined,
    tokenOutDecimals: input.token_out_decimals as number | undefined,
    fee: input.fee as 100 | 500 | 3000 | 10000 | undefined,
    slippageBps: input.slippage_bps as number | undefined,
  };
}

function hasExplicitLiveConfirmation(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return /\b(confirm|approved?|authorize|execute)\b/.test(normalized)
    && /\b(live|real|on-chain|onchain|swap|trade)\b/.test(normalized);
}

async function runTool(name: string, input: Record<string, unknown>, currentText: string, services?: HskAgentServices): Promise<string> {
  try {
    switch (name) {
      case 'hsk_agent_status': return JSON.stringify(getHskAgentStatus());
      case 'hsk_analyze_signals':
        return JSON.stringify(analyzeSixSignals({
          candles: input.candles as Array<{ close: number; volume: number }>,
          orderBook: { bidVolume: Number(input.bid_volume || 0), askVolume: Number(input.ask_volume || 0) },
          sentiment: Number(input.sentiment || 0),
        }));
      case 'hsk_quote_swap': return JSON.stringify(await quoteHskSwap(swapRequest(input)));
      case 'hsk_execute_swap':
        if (!hasExplicitLiveConfirmation(currentText)) {
          return JSON.stringify({ error: 'Live execution blocked: explicitly confirm this exact live HSKSwap trade in the current message.' });
        }
        return JSON.stringify(services?.executeSwap
          ? await services.executeSwap(swapRequest(input), { currentText })
          : await executeHskSwap({ ...swapRequest(input), confirmLiveTrade: true }));
      case 'hsk_portfolio': {
        if (!services) throw new Error('Portfolio service is unavailable');
        const raw = input.mark_prices_usd as Record<string, unknown> | undefined;
        const marks = Object.fromEntries(Object.entries(raw || {}).map(([key, value]) => [key.toUpperCase(), Number(value)]));
        return JSON.stringify(services.ledger.getPortfolio(marks));
      }
      case 'hsk_strategies':
        if (!services) throw new Error('Strategy service is unavailable');
        return JSON.stringify({ strategies: services.strategies.list(), killSwitch: services.strategies.isKilled(), risk: services.risk.getStatus(), market: services.marketStatus?.() });
      case 'hsk_opportunities':
        if (!services) throw new Error('Market opportunity service is unavailable');
        return JSON.stringify({ opportunities: services.marketOpportunities?.() || [], market: services.marketStatus?.() });
      case 'hsk_update_strategy':
        if (!services) throw new Error('Strategy service is unavailable');
        return JSON.stringify(services.strategies.upsert({
          id: String(input.id || ''), enabled: input.enabled as boolean | undefined, live: input.live as boolean | undefined,
          intervalMs: input.interval_ms as number | undefined, tokenIn: input.token_in as string | undefined,
          tokenOut: input.token_out as string | undefined, amountIn: input.amount_in as string | undefined,
          pool: input.pool as string | undefined, fee: input.fee as 100 | 500 | 3000 | 10000 | undefined,
          slippageBps: input.slippage_bps as number | undefined, minConfidence: input.min_confidence as number | undefined,
          maxPositionPct: input.max_position_pct as number | undefined, maxDailyLossPct: input.max_daily_loss_pct as number | undefined,
          stopLossPct: input.stop_loss_pct as number | undefined, assetAllowlist: input.asset_allowlist as string[] | undefined,
        }));
      case 'hsk_set_kill_switch':
        if (!services) throw new Error('Risk service is unavailable');
        services.strategies.setKillSwitch(Boolean(input.enabled));
        services.risk.setKillSwitch(Boolean(input.enabled), String(input.reason || ''));
        return JSON.stringify({ enabled: Boolean(input.enabled), reason: String(input.reason || '') });
      default: return JSON.stringify({ error: `Unsupported tool: ${name}` });
    }
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
  }
}

export async function createAgentManager(
  config: Config,
  sessionManager: SessionStore,
  configProvider?: () => Config,
  services?: HskAgentServices,
): Promise<AgentManager> {
  let client: Anthropic | null = null;
  const getConfig = configProvider || (() => config);

  async function handleMessage(message: IncomingMessage, session: Session): Promise<string> {
    const messages: Anthropic.MessageParam[] = sessionManager.getHistory(session)
      .map(item => ({ role: item.role, content: item.content }));
    messages.push({ role: 'user', content: message.text });
    sessionManager.addToHistory(session, 'user', message.text);
    const liveConfig = getConfig();
    const model = session.context.modelOverride || process.env.OPENROUTER_MODEL
      || liveConfig.agents.defaults.model.primary || 'openrouter/auto';
    const system = session.context.routedAgentPrompt || SYSTEM_PROMPT;

    try {
      const llm = client ||= createLlmClient();
      let response = await withRetry(
        () => llm.messages.create({ model, max_tokens: 1400, system, tools: TOOLS, messages }),
        RETRY_POLICIES.default.config,
      );
      for (let turn = 0; response.stop_reason === 'tool_use' && turn < 6; turn++) {
        messages.push({ role: 'assistant', content: response.content });
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;
          logger.info({ tool: block.name }, 'Executing HSK agent tool');
          results.push({ type: 'tool_result', tool_use_id: block.id, content: await runTool(block.name, block.input as Record<string, unknown>, message.text, services) });
        }
        messages.push({ role: 'user', content: results });
        response = await withRetry(
          () => llm.messages.create({ model, max_tokens: 1400, system, tools: TOOLS, messages }),
          RETRY_POLICIES.default.config,
        );
      }
      const text = response.content.filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map(block => block.text).join('\n').trim() || 'The HSK agent completed the request without a text response.';
      sessionManager.addToHistory(session, 'assistant', text);
      session.context.messageCount++;
      session.updatedAt = new Date();
      return text;
    } catch (error) {
      logger.error({ error, model }, 'HSK agent request failed');
      return 'The HSK trading agent could not complete that request. Check the OpenRouter key/model and try again.';
    }
  }

  return {
    handleMessage,
    dispose() {},
    reloadSkills() {},
    reloadConfig(nextConfig) {
      config = nextConfig;
      client = null;
      logger.info({ model: nextConfig.agents.defaults.model.primary }, 'HSK agent configuration hot-reloaded');
    },
    getSkillCommands: () => [
      { name: 'hsk-status', description: 'Show HSK Chain, HSKSwap, OpenRouter, and risk configuration.' },
      { name: 'hsk-signals', description: 'Analyze the six HSKSwap signals.' },
      { name: 'hsk-quote', description: 'Request a dry-run HSKSwap quote.' },
      { name: 'hsk-portfolio', description: 'Show durable positions, fills, receipts, cost basis, and known P&L.' },
      { name: 'hsk-strategies', description: 'Inspect or update bounded automated strategies and the kill switch.' },
      { name: 'hsk-opportunities', description: 'Inspect fresh cross-pool price spreads net of configured execution costs.' },
    ],
  };
}
