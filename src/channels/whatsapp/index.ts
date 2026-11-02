/** Focused WhatsApp adapter for the HSK trading agent. */
import makeWASocket, { DisconnectReason, useMultiFileAuthState, type WASocket } from '@whiskeysockets/baileys';
import { join } from 'path';
import type { ChannelAdapter, ChannelCallbacks } from '../types';
import type { IncomingMessage, OutgoingMessage, WhatsAppConfigShape } from '../../types';
import { logger } from '../../utils/logger';

export type WhatsAppConfig = WhatsAppConfigShape;

export async function createWhatsAppChannel(config: WhatsAppConfig, callbacks: ChannelCallbacks): Promise<ChannelAdapter> {
  let socket: WASocket | null = null;
  const allowlist = new Set(config.allowFrom || []);

  const connect = async () => {
    const { state, saveCreds } = await useMultiFileAuthState(config.authDir || join(process.cwd(), '.clodds-whatsapp'));
    socket = makeWASocket({ auth: state, markOnlineOnConnect: false });
    socket.ev.on('creds.update', saveCreds);
    socket.ev.on('connection.update', update => {
      if (update.qr) logger.info({ qr: update.qr }, 'Scan this WhatsApp QR payload with the linked-devices screen');
      if (update.connection === 'open') logger.info('WhatsApp HSK channel started');
      const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      if (update.connection === 'close' && code !== DisconnectReason.loggedOut) void connect();
    });
    socket.ev.on('messages.upsert', async event => {
      for (const item of event.messages) {
        if (!item.message || item.key.fromMe || !item.key.remoteJid) continue;
        const text = item.message.conversation || item.message.extendedTextMessage?.text || '';
        if (!text) continue;
        const userId = (item.key.participant || item.key.remoteJid).split('@')[0];
        if (config.dmPolicy !== 'open' && allowlist.size > 0 && !allowlist.has(userId)) continue;
        const message: IncomingMessage = {
          platform: 'whatsapp',
          userId,
          chatId: item.key.remoteJid,
          chatType: item.key.remoteJid.endsWith('@g.us') ? 'group' : 'dm',
          text,
          timestamp: new Date(Number(item.messageTimestamp || 0) * 1000),
          messageId: item.key.id || undefined,
        };
        await callbacks.onMessage(message);
      }
    });
  };

  return {
    platform: 'whatsapp',
    async start() { await connect(); },
    async stop() { socket?.end(undefined); socket = null; },
    async sendMessage(message: OutgoingMessage) {
      if (!socket) throw new Error('WhatsApp is not connected');
      const sent = await socket.sendMessage(message.chatId, { text: message.text });
      return sent?.key.id || null;
    },
  };
}
