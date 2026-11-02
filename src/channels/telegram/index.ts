/** Focused Telegram adapter for the HSK trading agent. */
import { Bot } from 'grammy';
import type { ChannelAdapter, ChannelCallbacks } from '../types';
import type { IncomingMessage, OutgoingMessage, TelegramConfig } from '../../types';
import { logger } from '../../utils/logger';

export async function createTelegramChannel(config: TelegramConfig, callbacks: ChannelCallbacks): Promise<ChannelAdapter> {
  const bot = new Bot(config.botToken);
  const allowlist = new Set(config.allowFrom || []);
  const allowed = (id: string) => config.dmPolicy === 'open' || allowlist.size === 0 || allowlist.has(id);

  bot.command('start', context => context.reply(
    'Clodds HSK is ready. Ask for HSKSwap status, a six-signal analysis, or a dry-run quote.',
  ));
  bot.on('message:text', async context => {
    const userId = String(context.from.id);
    if (!allowed(userId)) {
      await context.reply('This Telegram account is not authorized for the HSK trading agent.');
      return;
    }
    const message: IncomingMessage = {
      platform: 'telegram',
      userId,
      username: context.from.username,
      chatId: String(context.chat.id),
      chatType: context.chat.type === 'private' ? 'dm' : 'group',
      text: context.message.text,
      timestamp: new Date(context.message.date * 1000),
      messageId: String(context.message.message_id),
    };
    await callbacks.onMessage(message);
  });

  return {
    platform: 'telegram',
    async start() {
      void bot.start({ onStart: info => logger.info({ username: info.username }, 'Telegram HSK channel started') })
        .catch(error => logger.error({ error }, 'Telegram HSK channel stopped unexpectedly'));
    },
    async stop() { await bot.stop(); },
    async sendMessage(message: OutgoingMessage) {
      const sent = await bot.api.sendMessage(message.chatId, message.text, {
        parse_mode: message.parseMode === 'Markdown' ? 'Markdown' : undefined,
      });
      return String(sent.message_id);
    },
  };
}
