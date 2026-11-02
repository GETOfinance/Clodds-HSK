/** Shared types for the HSK-only Clodds runtime. */
export type ChatType = 'dm' | 'group';
export type ParseMode = 'Markdown' | 'HTML' | 'plain';

export interface MessageAttachment {
  type: 'image' | 'video' | 'audio' | 'document' | 'file';
  url?: string;
  data?: Buffer;
  filename?: string;
  mimeType?: string;
  caption?: string;
}

export interface IncomingMessage {
  id?: string;
  platform: string;
  accountId?: string;
  userId: string;
  username?: string;
  chatId: string;
  chatType: ChatType;
  text: string;
  timestamp: Date;
  messageId?: string;
  thread?: string;
  replyTo?: string;
  attachments?: MessageAttachment[];
}

export interface OutgoingMessage {
  platform: string;
  accountId?: string;
  chatId: string;
  text: string;
  parseMode?: ParseMode;
  thread?: string;
  replyTo?: string;
  attachments?: MessageAttachment[];
  buttons?: Array<{ text: string; callbackData?: string; url?: string }>;
}

export interface ReactionMessage extends Omit<OutgoingMessage, 'text'> { messageId: string; emoji: string }
export interface PollMessage extends Omit<OutgoingMessage, 'text'> { question: string; options: string[]; allowsMultipleAnswers?: boolean }
export interface ConversationMessage { role: 'user' | 'assistant'; content: string; timestamp: number }

export interface Session {
  id: string;
  key: string;
  userId: string;
  channel: string;
  chatId: string;
  chatType: ChatType;
  context: {
    messageCount: number;
    lastMarkets: string[];
    preferences: Record<string, unknown>;
    conversationHistory: ConversationMessage[];
    modelOverride?: string;
    routedAgentPrompt?: string;
  };
  history: ConversationMessage[];
  lastActivity: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface RateLimitConfig { maxRequests: number; windowMs: number; perUser?: boolean }
export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  dmPolicy?: 'open' | 'allowlist' | 'pairing' | 'disabled';
  allowFrom?: string[];
  rateLimit?: RateLimitConfig;
}
export interface WhatsAppConfigShape {
  enabled: boolean;
  authDir?: string;
  dmPolicy?: 'open' | 'allowlist' | 'pairing' | 'disabled';
  allowFrom?: string[];
}
export interface Config {
  gateway: { port: number; auth?: { token?: string } };
  agents: { defaults: { workspace: string; model: { primary: string }; rateLimit: RateLimitConfig } };
  channels: {
    webchat?: { enabled: boolean; authToken?: string };
    telegram?: TelegramConfig;
    whatsapp?: WhatsAppConfigShape;
  };
}
