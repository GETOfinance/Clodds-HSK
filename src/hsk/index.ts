import {
  Contract,
  JsonRpcProvider,
  Wallet,
  formatUnits,
  getAddress,
  parseUnits,
} from 'ethers';

export const HSK_CHAIN = {
  id: 177,
  name: 'HSK Chain Mainnet',
  nativeCurrency: { name: 'HSK', symbol: 'HSK', decimals: 18 },
  rpcUrls: ['https://mainnet.hsk.xyz', 'https://hsk-mainnet.hashkey.com'],
  explorerUrl: 'https://hashkey.blockscout.com',
  dexUrl: 'https://app.hskswap.com/?lng=en-US',
} as const;

export const HSKSWAP_CONTRACTS = {
  factoryV3: '0x972cA9D1662F5e029cD18327D29026532E84c742',
  swapRouter02: '0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3',
  quoterV2: '0x603f70466fDdbE3F238220B9a74FFF419a2BbFDD',
  positionManager: '0xDF0A9b833Db0E4CeEa103A4408f3B68e7FC0cad5',
} as const;

export const HSK_TOKENS = {
  WHSK: '0xB210D2120d57b758EE163cFfb43e73728c471Cf1',
  WETH: '0xefd4bC9afD210517803f293ABABd701CaeeCdfd0',
  USDT: '0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029',
  WBTC: '0x6119ca49a79f5825c8b345f8d7ac36b272565b14',
  USDC: '0x054ed45810DbBAb8B27668922D110669c9D88D0a',
} as const;

export interface Candle {
  close: number;
  volume: number;
}

export interface SixSignalInput {
  candles: Candle[];
  orderBook?: { bidVolume: number; askVolume: number };
  sentiment?: number;
}

export interface SignalReading {
  name: 'RSI' | 'MACD' | 'Bollinger' | 'Volume' | 'Order Book' | 'Sentiment';
  score: number;
  value: number;
  state: 'bullish' | 'neutral' | 'bearish';
}

export interface TradingDecision {
  action: 'buy' | 'hold' | 'sell';
  score: number;
  confidence: number;
  signals: SignalReading[];
  reason: string;
}

const clamp = (value: number, min = -1, max = 1) => Math.min(max, Math.max(min, value));
const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
const signalState = (score: number): SignalReading['state'] => score > 0.15 ? 'bullish' : score < -0.15 ? 'bearish' : 'neutral';

function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const multiplier = 2 / (period + 1);
  const output = [values[0]];
  for (let i = 1; i < values.length; i++) {
    output.push(values[i] * multiplier + output[i - 1] * (1 - multiplier));
  }
  return output;
}

function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  if (losses === 0) return gains === 0 ? 50 : 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

export function analyzeSixSignals(input: SixSignalInput): TradingDecision {
  if (input.candles.length < 20) {
    throw new Error('At least 20 candles are required for six-signal analysis');
  }
  const closes = input.candles.map(candle => candle.close);
  const volumes = input.candles.map(candle => candle.volume);
  if (closes.some(value => !Number.isFinite(value) || value <= 0) || volumes.some(value => !Number.isFinite(value) || value < 0)) {
    throw new Error('Candles must contain positive finite closes and non-negative finite volumes');
  }

  const currentRsi = rsi(closes);
  const rsiScore = clamp((50 - currentRsi) / 25);

  const fast = ema(closes, 12);
  const slow = ema(closes, 26);
  const macdSeries = closes.map((_, index) => fast[index] - slow[index]);
  const macdSignal = ema(macdSeries, 9);
  const macdHistogram = macdSeries.at(-1)! - macdSignal.at(-1)!;
  const macdScore = clamp(macdHistogram / Math.max(closes.at(-1)! * 0.01, Number.EPSILON));

  const recent = closes.slice(-20);
  const middle = average(recent);
  const deviation = Math.sqrt(average(recent.map(value => (value - middle) ** 2)));
  const bollingerPosition = deviation === 0 ? 0 : (closes.at(-1)! - middle) / (2 * deviation);
  const bollingerScore = clamp(-bollingerPosition);

  const baselineVolume = average(volumes.slice(-20, -1));
  const priceMomentum = (closes.at(-1)! - closes.at(-2)!) / closes.at(-2)!;
  const volumeRatio = baselineVolume > 0 ? volumes.at(-1)! / baselineVolume : 1;
  const volumeScore = clamp(Math.sign(priceMomentum) * Math.max(0, volumeRatio - 1) / 2);

  const bidVolume = input.orderBook?.bidVolume ?? 0;
  const askVolume = input.orderBook?.askVolume ?? 0;
  const orderBookImbalance = bidVolume + askVolume > 0 ? (bidVolume - askVolume) / (bidVolume + askVolume) : 0;
  const sentiment = clamp(input.sentiment ?? 0);

  const readings: SignalReading[] = [
    { name: 'RSI', score: rsiScore, value: currentRsi, state: signalState(rsiScore) },
    { name: 'MACD', score: macdScore, value: macdHistogram, state: signalState(macdScore) },
    { name: 'Bollinger', score: bollingerScore, value: bollingerPosition, state: signalState(bollingerScore) },
    { name: 'Volume', score: volumeScore, value: volumeRatio, state: signalState(volumeScore) },
    { name: 'Order Book', score: clamp(orderBookImbalance), value: orderBookImbalance, state: signalState(orderBookImbalance) },
    { name: 'Sentiment', score: sentiment, value: sentiment, state: signalState(sentiment) },
  ];

  const weights = [0.2, 0.2, 0.16, 0.14, 0.18, 0.12];
  const score = readings.reduce((sum, reading, index) => sum + reading.score * weights[index], 0);
  const agreement = Math.abs(readings.filter(reading => Math.sign(reading.score) === Math.sign(score) && Math.abs(reading.score) > 0.15).length / readings.length);
  const confidence = clamp(Math.abs(score) * 0.65 + agreement * 0.35, 0, 1);
  const action = score >= 0.22 && confidence >= 0.45 ? 'buy' : score <= -0.22 && confidence >= 0.45 ? 'sell' : 'hold';

  return {
    action,
    score,
    confidence,
    signals: readings,
    reason: action === 'hold'
      ? 'The six-signal consensus is below the execution threshold.'
      : `${readings.filter(reading => reading.state === (action === 'buy' ? 'bullish' : 'bearish')).length}/6 signals support a ${action} decision.`,
  };
}

const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
];
const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
];
const ERC20_ABI = [
  'function allowance(address owner,address spender) view returns (uint256)',
  'function approve(address spender,uint256 amount) returns (bool)',
];

export interface SwapRequest {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  tokenInDecimals?: number;
  tokenOutDecimals?: number;
  fee?: 100 | 500 | 3000 | 10000;
  slippageBps?: number;
}

export async function getHskProvider(): Promise<JsonRpcProvider> {
  const provider = new JsonRpcProvider(process.env.HSK_RPC_URL || HSK_CHAIN.rpcUrls[0], HSK_CHAIN.id, { staticNetwork: true });
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== HSK_CHAIN.id) throw new Error(`RPC chain mismatch: expected ${HSK_CHAIN.id}, received ${network.chainId}`);
  return provider;
}

export async function quoteHskSwap(request: SwapRequest) {
  const provider = await getHskProvider();
  const tokenIn = getAddress(request.tokenIn);
  const tokenOut = getAddress(request.tokenOut);
  if (tokenIn === tokenOut) throw new Error('tokenIn and tokenOut must differ');
  const tokenInDecimals = request.tokenInDecimals ?? 18;
  const tokenOutDecimals = request.tokenOutDecimals ?? 18;
  const amountIn = parseUnits(request.amountIn, tokenInDecimals);
  const fee = request.fee ?? 3000;
  const quoter = new Contract(HSKSWAP_CONTRACTS.quoterV2, QUOTER_ABI, provider);
  const result = await quoter.quoteExactInputSingle.staticCall({ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0 });
  const amountOut = result[0] as bigint;
  const slippageBps = Math.min(2_000, Math.max(1, request.slippageBps ?? 50));
  const amountOutMinimum = amountOut * BigInt(10_000 - slippageBps) / 10_000n;
  return {
    chainId: HSK_CHAIN.id,
    dex: 'HSKSwap',
    tokenIn,
    tokenOut,
    fee,
    amountIn: amountIn.toString(),
    amountOut: amountOut.toString(),
    amountOutFormatted: formatUnits(amountOut, tokenOutDecimals),
    amountOutMinimum: amountOutMinimum.toString(),
    gasEstimate: (result[3] as bigint).toString(),
    slippageBps,
  };
}

export async function executeHskSwap(request: SwapRequest & { confirmLiveTrade: boolean }) {
  if (process.env.HSK_LIVE_TRADING !== 'true') throw new Error('Live trading is disabled. Set HSK_LIVE_TRADING=true after validating dry-run quotes.');
  if (!request.confirmLiveTrade) throw new Error('confirmLiveTrade=true is required for every live swap');
  const privateKey = process.env.HSK_PRIVATE_KEY || process.env.EVM_PRIVATE_KEY;
  if (!privateKey) throw new Error('HSK_PRIVATE_KEY is required for live HSKSwap execution');
  const quote = await quoteHskSwap(request);
  const provider = await getHskProvider();
  const wallet = new Wallet(privateKey, provider);
  const token = new Contract(quote.tokenIn, ERC20_ABI, wallet);
  const allowance = await token.allowance(wallet.address, HSKSWAP_CONTRACTS.swapRouter02) as bigint;
  if (allowance < BigInt(quote.amountIn)) {
    const approval = await token.approve(HSKSWAP_CONTRACTS.swapRouter02, quote.amountIn);
    await approval.wait();
  }
  const router = new Contract(HSKSWAP_CONTRACTS.swapRouter02, ROUTER_ABI, wallet);
  const transaction = await router.exactInputSingle({
    tokenIn: quote.tokenIn,
    tokenOut: quote.tokenOut,
    fee: quote.fee,
    recipient: wallet.address,
    amountIn: quote.amountIn,
    amountOutMinimum: quote.amountOutMinimum,
    sqrtPriceLimitX96: 0,
  });
  const receipt = await transaction.wait();
  return { hash: transaction.hash, blockNumber: receipt?.blockNumber, explorerUrl: `${HSK_CHAIN.explorerUrl}/tx/${transaction.hash}`, quote };
}

export function getHskAgentStatus() {
  return {
    network: HSK_CHAIN,
    dex: { name: 'HSKSwap', url: HSK_CHAIN.dexUrl, contracts: HSKSWAP_CONTRACTS },
    supportedTokens: HSK_TOKENS,
    signals: ['RSI', 'MACD', 'Bollinger', 'Volume', 'Order Book', 'Sentiment'],
    mode: process.env.HSK_LIVE_TRADING === 'true' ? 'live' : 'dry-run',
    automation: {
      enabled: process.env.HSK_AUTONOMOUS_TRADING === 'true',
      marketIndexerConfigured: Boolean(process.env.HSK_POOL_ADDRESSES),
      durableState: true,
      requiresAssetAllowlist: true,
      killSwitchEnforced: true,
    },
    llm: { provider: 'OpenRouter', model: process.env.OPENROUTER_MODEL || 'openrouter/auto' },
    risk: {
      maxPositionPct: Number(process.env.HSK_MAX_POSITION_PCT || 5),
      maxDailyLossPct: Number(process.env.HSK_MAX_DAILY_LOSS_PCT || 2),
      stopLossPct: Number(process.env.HSK_STOP_LOSS_PCT || 3),
      minConfidence: Number(process.env.HSK_MIN_SIGNAL_CONFIDENCE || 0.45),
    },
  };
}
