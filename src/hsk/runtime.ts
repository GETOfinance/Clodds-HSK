/** Lightweight HSK-only HTTP, WebSocket, Telegram, and WhatsApp runtime. */
import { createServer } from 'http';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import { WebSocketServer } from 'ws';
import type { IncomingMessage } from '../types';
import { createHskChannelManager } from './channels';
import { createAgentManager } from '../agents';
import { loadConfig } from '../utils/config';
import { analyzeSixSignals, executeHskSwap, getHskAgentStatus, getHskProvider, quoteHskSwap, type SwapRequest } from './index';
import { logger } from '../utils/logger';
import { DurableSessionManager } from './session-store';
import { TradingLedger } from './ledger';
import { HskMarketIndexer } from './market';
import { StrategyScheduler, StrategyStore, type StrategyConfig } from './automation';
import { parseMarkPrices, PortfolioRiskManager } from './risk';
import { getTradingMode, tradingModeEnv, validateTradingMode, type TradingMode } from './trading-mode';

const SETTINGS_SCHEMA = [
  { category: 'Core', vars: [
    { key: 'OPENROUTER_API_KEY', label: 'OpenRouter API Key', secret: true, required: true, helpUrl: 'https://openrouter.ai/keys' },
    { key: 'OPENROUTER_MODEL', label: 'OpenRouter Model', secret: false, required: false, helpUrl: 'https://openrouter.ai/models', control: 'openrouter-model' },
  ] },
  { category: 'HSK Chain & Risk', vars: [
    { key: 'HSK_RPC_URL', label: 'HSK Chain Mainnet RPC', secret: false, required: false },
    { key: 'HSK_PRIVATE_KEY', label: 'Dedicated HSK Hot-Wallet Key', secret: true, required: false },
    { key: 'HSK_LIVE_TRADING', label: 'Enable Live Trading', secret: false, required: false },
    { key: 'HSK_AUTONOMOUS_TRADING', label: 'Enable Bounded Autonomous Trading', secret: false, required: false },
    { key: 'HSK_POOL_ADDRESSES', label: 'Indexed HSKSwap Pool Addresses', secret: false, required: false },
    { key: 'HSK_POOL_GROUPS', label: 'Comparable Pool Groups JSON', secret: false, required: false },
    { key: 'HSK_MIN_NET_SPREAD_BPS', label: 'Minimum Net Spread BPS', secret: false, required: false },
    { key: 'HSK_ARBITRAGE_COST_BPS', label: 'Estimated Arbitrage Costs BPS', secret: false, required: false },
    { key: 'HSK_ASSET_ALLOWLIST', label: 'Autonomous Asset Allowlist', secret: false, required: false },
    { key: 'HSK_MARK_PRICES_USD', label: 'Independent USD Mark Prices JSON', secret: false, required: false },
    { key: 'HSK_PORTFOLIO_VALUE_USD', label: 'Verified Portfolio Value USD', secret: false, required: false },
    { key: 'HSK_MAX_POSITION_PCT', label: 'Maximum Position %', secret: false, required: false },
    { key: 'HSK_MAX_DAILY_LOSS_PCT', label: 'Maximum Daily Loss %', secret: false, required: false },
    { key: 'HSK_STOP_LOSS_PCT', label: 'Stop Loss %', secret: false, required: false },
    { key: 'HSK_MIN_SIGNAL_CONFIDENCE', label: 'Minimum Signal Confidence', secret: false, required: false },
  ] },
  { category: 'Channels', vars: [
    { key: 'WEBCHAT_TOKEN', label: 'WebChat Token', secret: true, required: false },
    { key: 'TELEGRAM_BOT_TOKEN', label: 'Telegram Bot Token', secret: true, required: false, helpUrl: 'https://t.me/BotFather' },
    { key: 'WHATSAPP_ENABLED', label: 'Enable WhatsApp QR Session', secret: false, required: false },
    { key: 'WHATSAPP_AUTH_DIR', label: 'WhatsApp Auth Directory', secret: false, required: false },
    { key: 'TWITTER_BEARER_TOKEN', label: 'X Bearer Token', secret: true, required: false },
  ] },
];

async function main() {
  let config = await loadConfig();
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  const sessionManager = new DurableSessionManager();
  const ledger = new TradingLedger();
  const strategies = new StrategyStore();
  const risk = new PortfolioRiskManager(ledger);
  let poolGroups: Record<string, string[]> = {};
  try { poolGroups = JSON.parse(process.env.HSK_POOL_GROUPS || '{}') as Record<string, string[]>; }
  catch { throw new Error('HSK_POOL_GROUPS must be valid JSON mapping pair names to pool-address arrays'); }
  const initialPoolAddresses = (process.env.HSK_POOL_ADDRESSES || '').split(',').map(item => item.trim()).filter(Boolean);
  let marketIndexer: HskMarketIndexer | null = initialPoolAddresses.length > 0
    ? new HskMarketIndexer(await getHskProvider(), initialPoolAddresses)
    : null;

  const persistEnvironment = (updates: Record<string, unknown>) => {
    const envPath = join(process.cwd(), '.env');
    const lines = existsSync(envPath) ? readFileSync(envPath, 'utf8').split('\n') : [];
    for (const [key, raw] of Object.entries(updates)) {
      const value = String(raw ?? '');
      if (/[\r\n]/.test(value)) throw new Error(`Invalid value for ${key}`);
      const line = `${key}="${value.replace(/"/g, '\\"')}"`;
      const index = lines.findIndex(existing => existing.startsWith(`${key}=`));
      if (index >= 0) lines[index] = line; else lines.push(line);
      process.env[key] = value;
    }
    writeFileSync(envPath, lines.join('\n'), { mode: 0o600 });
  };

  const refreshMarketConfiguration = async () => {
    let nextPoolGroups: Record<string, string[]> = {};
    try { nextPoolGroups = JSON.parse(process.env.HSK_POOL_GROUPS || '{}') as Record<string, string[]>; }
    catch { throw new Error('HSK_POOL_GROUPS must be valid JSON mapping pair names to pool-address arrays'); }
    const pools = (process.env.HSK_POOL_ADDRESSES || '').split(',').map(item => item.trim()).filter(Boolean);
    const previous = marketIndexer;
    const next = pools.length > 0 ? new HskMarketIndexer(await getHskProvider(), pools) : null;
    previous?.stop();
    marketIndexer = next;
    poolGroups = nextPoolGroups;
    marketIndexer?.start(Number(process.env.HSK_INDEX_INTERVAL_MS || 15_000));
  };

  const controlledExecute = async (
    request: SwapRequest,
    context: { confidence?: number; strategy?: StrategyConfig } = {},
  ) => {
    const prices = parseMarkPrices();
    const markPrice = prices[request.tokenIn.toLowerCase()];
    if (!markPrice) throw new Error(`Missing independent USD mark price for ${request.tokenIn}`);
    const notionalUsd = Number(request.amountIn) * markPrice;
    const portfolioValueUsd = Number(process.env.HSK_PORTFOLIO_VALUE_USD || 0);
    const configuredAllowlist = (process.env.HSK_ASSET_ALLOWLIST || '').split(',').map(item => item.trim()).filter(Boolean);
    const allowedAssets = context.strategy?.assetAllowlist.length ? context.strategy.assetAllowlist : configuredAllowlist;
    risk.assertTrade({
      asset: request.tokenOut,
      notionalUsd,
      portfolioValueUsd,
      confidence: context.confidence,
      allowedAssets,
      maxPositionPct: context.strategy?.maxPositionPct,
      maxDailyLossPct: context.strategy?.maxDailyLossPct,
      minConfidence: context.strategy?.minConfidence,
    });
    const result = await executeHskSwap({ ...request, confirmLiveTrade: true });
    ledger.recordSwap({
      transactionHash: result.hash,
      blockNumber: result.blockNumber,
      tokenIn: result.quote.tokenIn,
      tokenOut: result.quote.tokenOut,
      amountIn: result.quote.amountIn,
      amountOut: result.quote.amountOut,
      strategyId: context.strategy?.id,
    });
    const quantityIn = Number(request.amountIn);
    const quantityOut = Number(result.quote.amountOutFormatted);
    const existingInput = ledger.getPosition(result.quote.tokenIn);
    if (existingInput && existingInput.quantity >= quantityIn) {
      ledger.recordFill({ asset: result.quote.tokenIn, side: 'sell', quantity: quantityIn, priceUsd: markPrice, feeUsd: 0, transactionHash: result.hash, strategyId: context.strategy?.id });
    }
    if (Number.isFinite(quantityOut) && quantityOut > 0) {
      ledger.recordFill({ asset: result.quote.tokenOut, side: 'buy', quantity: quantityOut, priceUsd: notionalUsd / quantityOut, feeUsd: 0, transactionHash: result.hash, strategyId: context.strategy?.id });
    }
    return result;
  };

  let channels: Awaited<ReturnType<typeof createHskChannelManager>>;
  const agent = await createAgentManager(
    config,
    sessionManager,
    undefined,
    {
      ledger,
      strategies,
      risk,
      marketStatus: () => marketIndexer?.getStatus() || { configured: false, reason: 'Set HSK_POOL_ADDRESSES to enable indexing' },
      marketOpportunities: () => marketIndexer?.detectPriceSpreads(poolGroups, Number(process.env.HSK_MIN_NET_SPREAD_BPS || 10), Number(process.env.HSK_ARBITRAGE_COST_BPS || 100)) || [],
      executeSwap: request => controlledExecute(request),
    },
  );

  const scheduler = new StrategyScheduler(strategies, {
    decide: async strategy => {
      if (!marketIndexer) throw new Error('Market indexer is not configured');
      const candles = marketIndexer.getCandles(strategy.pool, 200);
      if (candles.length < 20) throw new Error('At least 20 indexed candles are required');
      const marks = parseMarkPrices();
      const targetMark = marks[strategy.tokenOut.toLowerCase()];
      if (targetMark && risk.isStopLossTriggered(strategy.tokenOut, targetMark, strategy.stopLossPct)) {
        return { action: 'sell' as const, score: -1, confidence: 1, signals: [], reason: `Stop loss triggered at ${strategy.stopLossPct}%` };
      }
      return analyzeSixSignals({ candles: candles.map(item => ({ close: item.close, volume: item.volume })) });
    },
    quote: async (strategy, decision) => {
      const sell = decision.action === 'sell';
      return quoteHskSwap({ tokenIn: sell ? strategy.tokenOut : strategy.tokenIn, tokenOut: sell ? strategy.tokenIn : strategy.tokenOut, amountIn: strategy.amountIn, fee: strategy.fee, slippageBps: strategy.slippageBps });
    },
    execute: async (strategy, decision) => {
      const sell = decision.action === 'sell';
      return controlledExecute({ tokenIn: sell ? strategy.tokenOut : strategy.tokenIn, tokenOut: sell ? strategy.tokenIn : strategy.tokenOut, amountIn: strategy.amountIn, fee: strategy.fee, slippageBps: strategy.slippageBps }, { confidence: decision.confidence, strategy });
    },
    onResult: result => logger.info({ automation: result }, 'HSK strategy run completed'),
  });

  const onChannelMessage = async (message: IncomingMessage) => {
      const session = await sessionManager.getOrCreateSession(message);
      const response = await agent.handleMessage(message, session);
      if (response) {
        await channels.send({
          platform: message.platform,
          accountId: message.accountId,
          chatId: message.chatId,
          text: response,
          parseMode: 'Markdown',
          thread: message.thread,
        });
      }
  };
  channels = await createHskChannelManager(config.channels, onChannelMessage);

  channels.attachWebSocket(wss);
  server.on('upgrade', (request, socket, head) => {
    const chatHandler = channels.getChatConnectionHandler();
    if (!request.url?.startsWith('/chat') || !chatHandler) return socket.destroy();
    wss.handleUpgrade(request, socket, head, ws => chatHandler(ws, request));
  });

  app.get('/', (_req, res) => res.redirect('/webchat'));
  const modeReadiness = (mode: TradingMode) => validateTradingMode(mode, {
    strategies: strategies.list(),
    strategyKillSwitch: strategies.isKilled(),
    riskKillSwitch: risk.getStatus().killSwitch,
  });
  app.get('/health', (_req, res) => res.json({ ok: true, service: 'clodds-hsk', chainId: 177, mode: getHskAgentStatus().mode, tradingMode: getTradingMode(), storage: 'durable', automation: process.env.HSK_AUTONOMOUS_TRADING === 'true' }));
  app.get('/api/hsk/status', (_req, res) => res.json({ ...getHskAgentStatus(), tradingMode: getTradingMode(), market: marketIndexer?.getStatus() || { configured: false }, risk: { ...getHskAgentStatus().risk, enforcement: risk.getStatus() }, strategies: strategies.list().length }));
  app.get('/api/hsk/trading-mode', (_req, res) => {
    const mode = getTradingMode();
    res.json({ mode, readiness: modeReadiness(mode) });
  });
  app.post('/api/hsk/trading-mode', async (req, res) => {
    const mode = req.body?.mode as TradingMode;
    if (!['dry-run', 'user', 'autonomous'].includes(mode)) return res.status(400).json({ error: 'Mode must be dry-run, user, or autonomous' });
    const readiness = modeReadiness(mode);
    if (!readiness.ready) return res.status(409).json({ error: `${mode === 'autonomous' ? 'Autonomous' : 'User'} trading prerequisites are incomplete`, mode: getTradingMode(), readiness });
    persistEnvironment(tradingModeEnv(mode));
    config = await loadConfig();
    agent.reloadConfig(config);
    return res.json({ success: true, mode: getTradingMode(), readiness: modeReadiness(mode) });
  });
  app.get('/api/hsk/market', (_req, res) => res.json({ status: marketIndexer?.getStatus() || { configured: false }, candles: marketIndexer?.getCandles(undefined, 200) || [], opportunities: marketIndexer?.detectPriceSpreads(poolGroups, Number(process.env.HSK_MIN_NET_SPREAD_BPS || 10), Number(process.env.HSK_ARBITRAGE_COST_BPS || 100)) || [] }));
  app.get('/api/hsk/portfolio', (req, res) => {
    const marks = req.query.marks ? JSON.parse(String(req.query.marks)) as Record<string, number> : {};
    res.json(ledger.getPortfolio(marks));
  });
  app.get('/api/hsk/strategies', (_req, res) => res.json({ strategies: strategies.list(), killSwitch: strategies.isKilled(), risk: risk.getStatus() }));
  app.get('/api/commands', (_req, res) => res.json({ commands: agent.getSkillCommands() }));

  type OpenRouterModel = {
    id?: string;
    name?: string;
    context_length?: number;
    pricing?: { prompt?: string; completion?: string };
    supported_parameters?: string[];
    architecture?: { output_modalities?: string[] };
    endpoints?: string[];
  };
  let modelCatalogCache: { expiresAt: number; models: unknown[] } | null = null;
  app.get('/api/openrouter/models', async (_req, res) => {
    try {
      if (modelCatalogCache && modelCatalogCache.expiresAt > Date.now()) {
        return res.json({ models: modelCatalogCache.models, cached: true, priceUnit: 'USD per 1M tokens' });
      }
      let response: Response | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        response = await fetch('https://openrouter.ai/api/v1/models', {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        }).catch(() => undefined);
        if (response?.ok) break;
      }
      if (!response) throw new Error('OpenRouter did not respond');
      if (!response.ok) throw new Error(`OpenRouter returned HTTP ${response.status}`);
      const payload = await response.json() as { data?: OpenRouterModel[] };
      const models = (payload.data || [])
        .filter(model => model.id && model.supported_parameters?.includes('tools'))
        .filter(model => model.endpoints?.includes('/api/v1/messages'))
        .filter(model => model.architecture?.output_modalities?.includes('text'))
        .filter(model => model.pricing?.prompt !== undefined && model.pricing?.completion !== undefined)
        .map(model => ({
          id: model.id as string,
          name: (model.name || model.id) as string,
          contextLength: model.context_length || null,
          inputPerMillion: Number(model.pricing?.prompt || 0) * 1_000_000,
          outputPerMillion: Number(model.pricing?.completion || 0) * 1_000_000,
        }))
        .filter(model => Number.isFinite(model.inputPerMillion) && Number.isFinite(model.outputPerMillion)
          && model.inputPerMillion >= 0 && model.outputPerMillion >= 0)
        .sort((a, b) => (a.inputPerMillion + a.outputPerMillion) - (b.inputPerMillion + b.outputPerMillion)
          || a.name.localeCompare(b.name));
      modelCatalogCache = { expiresAt: Date.now() + 10 * 60_000, models };
      res.setHeader('Cache-Control', 'private, max-age=600');
      return res.json({ models, cached: false, priceUnit: 'USD per 1M tokens' });
    } catch (error) {
      logger.warn({ error }, 'Could not load OpenRouter model catalog');
      return res.status(502).json({ error: 'OpenRouter model catalog is temporarily unavailable' });
    }
  });

  app.get('/api/config/env', (_req, res) => res.json({
    schema: SETTINGS_SCHEMA.map(category => ({
      ...category,
      vars: category.vars.map(item => ({
        ...item,
        set: Boolean(process.env[item.key]),
        masked: process.env[item.key] ? (item.secret ? '••••••••' : process.env[item.key]) : '',
      })),
    })),
  }));
  app.post('/api/config/env', async (req, res) => {
    const updates = req.body?.vars as Record<string, unknown> | undefined;
    const allowed = new Set(SETTINGS_SCHEMA.flatMap(category => category.vars.map(item => item.key)));
    if (!updates || Object.keys(updates).some(key => !allowed.has(key))) return res.status(400).json({ error: 'Invalid settings update' });
    try { persistEnvironment(updates); }
    catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
    config = await loadConfig();
    agent.reloadConfig(config);
    const marketKeys = new Set(['HSK_RPC_URL', 'HSK_POOL_ADDRESSES', 'HSK_POOL_GROUPS']);
    if (Object.keys(updates).some(key => marketKeys.has(key))) {
      try { await refreshMarketConfiguration(); }
      catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
    }
    const channelKeys = new Set(['WEBCHAT_TOKEN', 'TELEGRAM_BOT_TOKEN', 'WHATSAPP_ENABLED', 'WHATSAPP_AUTH_DIR']);
    if (Object.keys(updates).some(key => channelKeys.has(key))) {
      await channels.stop();
      channels = await createHskChannelManager(config.channels, onChannelMessage);
      channels.attachWebSocket(wss);
      await channels.start();
    }
    res.json({ success: true, applied: true, updated: Object.keys(updates) });
  });

  app.get('/api/chat/sessions', (req, res) => {
    const userId = String(req.query.userId || '');
    const result = sessionManager.list(userId)
      .map(session => ({ id: session.id, title: session.title, updatedAt: session.updatedAt.getTime(), messageCount: session.history.length, lastMessage: session.history.at(-1)?.content }));
    res.json({ sessions: result });
  });
  app.get('/api/chat/sessions/:id', (req, res) => {
    const session = sessionManager.getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({ id: session.id, title: session.title, messages: session.history.map((message, index) => ({ id: `${session.id}-${index}`, ...message })), updatedAt: session.updatedAt.getTime() });
  });
  app.post('/api/chat/sessions', (req, res) => {
    const session = sessionManager.create(String(req.body?.userId || 'web-anonymous'), 'webchat');
    res.json({ session: { id: session.id, updatedAt: session.updatedAt.getTime(), messageCount: 0 } });
  });
  app.patch('/api/chat/sessions/:id', (req, res) => {
    if (typeof req.body?.title !== 'string' || !sessionManager.setTitle(req.params.id, req.body.title)) return res.status(404).json({ error: 'Session not found' });
    res.json({ ok: true });
  });
  app.delete('/api/chat/sessions/:id', (req, res) => { sessionManager.deleteById(req.params.id); res.json({ ok: true }); });

  app.use('/webchat', express.static(join(__dirname, '../../public/webchat'), { setHeaders: response => response.setHeader('Cache-Control', 'no-store') }));

  marketIndexer?.start(Number(process.env.HSK_INDEX_INTERVAL_MS || 15_000));
  scheduler.start(Number(process.env.HSK_SCHEDULER_TICK_MS || 5_000));
  await channels.start();
  await new Promise<void>(resolve => server.listen(config.gateway.port, '0.0.0.0', resolve));
  logger.info({ port: config.gateway.port }, 'Clodds HSK runtime started');
  console.log(`Clodds HSK is running at http://localhost:${config.gateway.port}/webchat`);

  const shutdown = async () => {
    agent.dispose();
    scheduler.stop();
    marketIndexer?.stop();
    sessionManager.dispose();
    await channels.stop();
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch(error => {
  logger.error({ error }, 'Clodds HSK startup failed');
  process.exit(1);
});
