/** Minimal configuration for the HSKSwap-only runtime. */
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import JSON5 from 'json5';
import { config as dotenvConfig } from 'dotenv';
import type { Config } from '../types';
import { createLogger } from './logger';

const logger = createLogger('config');
dotenvConfig({ path: join(homedir(), '.clodds', '.env') });
dotenvConfig();

function resolveUserPath(input: string): string {
  const trimmed = input.trim();
  return trimmed.startsWith('~') ? resolve(trimmed.replace(/^~(?=$|[\\/])/, homedir())) : resolve(trimmed);
}

export function resolveStateDir(env = process.env): string {
  return env.CLODDS_STATE_DIR?.trim() ? resolveUserPath(env.CLODDS_STATE_DIR) : join(homedir(), '.clodds');
}

export function resolveConfigPath(env = process.env): string {
  return env.CLODDS_CONFIG_PATH?.trim() ? resolveUserPath(env.CLODDS_CONFIG_PATH) : join(resolveStateDir(env), 'clodds.json');
}

export function resolveWorkspaceDir(env = process.env): string {
  return env.CLODDS_WORKSPACE?.trim() ? resolveUserPath(env.CLODDS_WORKSPACE) : join(homedir(), 'clodds-hsk');
}

const CONFIG_DIR = resolveStateDir();
const CONFIG_FILE = resolveConfigPath();
const enabled = (value: string | undefined) => value === '1' || value?.toLowerCase() === 'true';

const DEFAULT_CONFIG: Config = {
  gateway: { port: 18789, auth: { token: process.env.CLODDS_TOKEN } },
  agents: {
    defaults: {
      workspace: resolveWorkspaceDir(),
      model: { primary: process.env.OPENROUTER_MODEL || 'openrouter/auto' },
      rateLimit: { maxRequests: 30, windowMs: 60_000 },
    },
  },
  channels: {
    webchat: { enabled: true, authToken: process.env.WEBCHAT_TOKEN },
    telegram: {
      enabled: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      botToken: process.env.TELEGRAM_BOT_TOKEN || '',
      dmPolicy: 'pairing',
      allowFrom: [],
    },
    whatsapp: {
      enabled: enabled(process.env.WHATSAPP_ENABLED),
      authDir: process.env.WHATSAPP_AUTH_DIR,
      dmPolicy: 'pairing',
      allowFrom: [],
    },
  },
} as unknown as Config;

function substituteEnvVars(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => process.env[name] || '');
  if (Array.isArray(value)) return value.map(substituteEnvVars);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substituteEnvVars(item)]));
  }
  return value;
}

function deepMerge<T>(target: T, source: Partial<T>): T {
  const blocked = new Set(['__proto__', 'constructor', 'prototype']);
  const result = { ...target } as Record<string, unknown>;
  for (const [key, sourceValue] of Object.entries(source as Record<string, unknown>)) {
    if (blocked.has(key) || sourceValue === undefined) continue;
    const targetValue = result[key];
    result[key] = sourceValue && targetValue && typeof sourceValue === 'object' && typeof targetValue === 'object'
      && !Array.isArray(sourceValue) && !Array.isArray(targetValue)
      ? deepMerge(targetValue as Record<string, unknown>, sourceValue as Record<string, unknown>)
      : sourceValue;
  }
  return result as T;
}

export async function loadConfig(customPath?: string): Promise<Config> {
  const configPath = customPath || CONFIG_FILE;
  let fileConfig: Partial<Config> = {};
  if (existsSync(configPath)) {
    try {
      fileConfig = JSON5.parse(readFileSync(configPath, 'utf8')) as Partial<Config>;
    } catch (error) {
      logger.error({ configPath, error }, 'Failed to parse configuration');
    }
  }
  const config = substituteEnvVars(deepMerge(DEFAULT_CONFIG, fileConfig)) as Config;
  if (process.env.OPENROUTER_MODEL) config.agents.defaults.model.primary = process.env.OPENROUTER_MODEL;
  config.channels.webchat = { enabled: true, authToken: process.env.WEBCHAT_TOKEN };
  config.channels.telegram = {
    enabled: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    dmPolicy: 'pairing',
    allowFrom: [],
  };
  config.channels.whatsapp = {
    enabled: enabled(process.env.WHATSAPP_ENABLED),
    authDir: process.env.WHATSAPP_AUTH_DIR,
    dmPolicy: 'pairing',
    allowFrom: [],
  };
  return config;
}

export { CONFIG_DIR, CONFIG_FILE };
