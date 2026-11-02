/** HSK runtime channel manager: WebChat, Telegram, and WhatsApp only. */
import type { WebSocketServer } from 'ws';
import type { Config, IncomingMessage, OutgoingMessage } from '../types';
import { createWebChatChannel } from '../channels/webchat';
import { createTelegramChannel } from '../channels/telegram';
import { createWhatsAppChannel, type WhatsAppConfig } from '../channels/whatsapp';
import { logger } from '../utils/logger';

type Sender = { start(): Promise<void> | void; stop(): Promise<void> | void; sendMessage(message: OutgoingMessage): Promise<string | null> };

export async function createHskChannelManager(
  config: Config['channels'],
  onMessage: (message: IncomingMessage) => Promise<void>,
) {
  const adapters = new Map<string, Sender>();
  const callbacks = { onMessage };
  const webchat = config.webchat?.enabled ? createWebChatChannel(config.webchat, callbacks) : null;

  if (config.telegram?.enabled && config.telegram.botToken) {
    adapters.set('telegram', await createTelegramChannel(config.telegram, callbacks));
  }
  if (config.whatsapp?.enabled) {
    adapters.set('whatsapp', await createWhatsAppChannel(config.whatsapp as WhatsAppConfig, callbacks));
  }

  return {
    attachWebSocket(wss: WebSocketServer) { webchat?.start(wss); },
    getChatConnectionHandler() { return webchat?.getConnectionHandler() || null; },
    async start() {
      for (const [platform, adapter] of adapters) {
        try { await adapter.start(); } catch (error) { logger.error({ platform, error }, 'Channel failed to start'); }
      }
    },
    async stop() {
      webchat?.stop();
      for (const adapter of adapters.values()) await adapter.stop();
    },
    async send(message: OutgoingMessage): Promise<string | null> {
      if (message.platform === 'webchat') return webchat?.sendMessage(message) || null;
      const adapter = adapters.get(message.platform);
      if (!adapter) throw new Error(`Channel is not enabled: ${message.platform}`);
      return adapter.sendMessage(message);
    },
  };
}
