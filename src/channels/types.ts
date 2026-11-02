import type { IncomingMessage, OutgoingMessage, PollMessage, ReactionMessage } from '../types';

export interface ChannelCallbacks {
  onMessage(message: IncomingMessage): Promise<void>;
}

export interface DraftStream {
  start(initialText?: string): Promise<string | null>;
  update(newText: string): Promise<void>;
  append?(additionalText: string): Promise<void>;
  finish(finalText?: string): Promise<string | null>;
  cancel(): Promise<void>;
  getMessageId?(): string | null;
  getText?(): string;
}

export interface ChannelAdapter {
  platform: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(message: OutgoingMessage): Promise<string | null>;
  isConnected?(message?: OutgoingMessage): boolean;
  handleEvent?(event: unknown, req?: unknown): Promise<unknown>;
  editMessage?(message: OutgoingMessage & { messageId: string }): Promise<void>;
  deleteMessage?(message: OutgoingMessage & { messageId: string }): Promise<void>;
  reactMessage?(message: ReactionMessage): Promise<void>;
  sendPoll?(message: PollMessage): Promise<string | null>;
  createDraftStream?(chatId: string): DraftStream;
}
