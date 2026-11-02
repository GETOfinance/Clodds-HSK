import { randomUUID } from 'crypto';
import type { ConversationMessage, IncomingMessage, Session } from '../types';
import { hskStatePath, JsonStateStore } from './state';

export type StoredSession = Session & { title?: string };
type SerializedSession = Omit<StoredSession, 'createdAt' | 'updatedAt' | 'lastActivity'> & {
  createdAt: string;
  updatedAt: string;
  lastActivity: string;
};
type SessionState = { version: 1; sessions: SerializedSession[] };

function serialize(session: StoredSession): SerializedSession {
  return {
    ...session,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    lastActivity: session.lastActivity.toISOString(),
  };
}

function deserialize(session: SerializedSession): StoredSession {
  return {
    ...session,
    createdAt: new Date(session.createdAt),
    updatedAt: new Date(session.updatedAt),
    lastActivity: new Date(session.lastActivity),
  };
}

export class DurableSessionManager {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly store: JsonStateStore<SessionState>;

  constructor(path = hskStatePath('sessions.json')) {
    this.store = new JsonStateStore(path, () => ({ version: 1, sessions: [] }));
    for (const item of this.store.load().sessions) this.sessions.set(item.id, deserialize(item));
  }

  private persist(): void {
    this.store.save({ version: 1, sessions: [...this.sessions.values()].map(serialize) });
  }

  create(userId: string, channel: string, chatId: string = randomUUID(), chatType: 'dm' | 'group' = 'dm'): StoredSession {
    const now = new Date();
    const session: StoredSession = {
      id: chatId,
      key: `hsk:${channel}:${chatId}:${userId}`,
      userId,
      channel,
      chatId,
      chatType,
      context: { messageCount: 0, lastMarkets: [], preferences: {}, conversationHistory: [] },
      history: [],
      lastActivity: now,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    this.persist();
    return session;
  }

  async getOrCreateSession(message: IncomingMessage): Promise<StoredSession> {
    return this.sessions.get(message.chatId) || this.create(message.userId, message.platform, message.chatId, message.chatType);
  }

  getSession(key: string): StoredSession | undefined { return [...this.sessions.values()].find(item => item.key === key); }
  getSessionById(id: string): StoredSession | undefined { return this.sessions.get(id); }
  list(userId = ''): StoredSession[] {
    return [...this.sessions.values()].filter(item => !userId || item.userId === userId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }
  updateSession(session: Session): void { this.sessions.set(session.id, session as StoredSession); this.persist(); }
  deleteSession(key: string): void {
    const target = this.getSession(key);
    if (target) { this.sessions.delete(target.id); this.persist(); }
  }
  deleteById(id: string): boolean { const deleted = this.sessions.delete(id); if (deleted) this.persist(); return deleted; }
  addToHistory(session: Session, role: 'user' | 'assistant', content: string): void {
    const item: ConversationMessage = { role, content, timestamp: Date.now() };
    session.history.push(item);
    session.context.conversationHistory.push(item);
    session.context.conversationHistory = session.context.conversationHistory.slice(-30);
    session.lastActivity = new Date();
    session.updatedAt = new Date();
    const stored = session as StoredSession;
    if (!stored.title && role === 'user') stored.title = content.slice(0, 55);
    this.sessions.set(session.id, stored);
    this.persist();
  }
  getHistory(session: Session): ConversationMessage[] { return session.context.conversationHistory.slice(-30); }
  clearHistory(session: Session): void { session.history = []; session.context.conversationHistory = []; this.updateSession(session); }
  reset(id: string): void { const session = this.sessions.get(id); if (session) this.clearHistory(session); }
  setTitle(id: string, title: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.title = title.slice(0, 80);
    session.updatedAt = new Date();
    this.persist();
    return true;
  }
  saveCheckpoint(): void { this.persist(); }
  restoreCheckpoint(): boolean { return true; }
  checkScheduledResets(): void {}
  dispose(): void { this.persist(); }
  getConfig() {
    return {
      dmScope: 'per-channel-peer' as const,
      reset: { mode: 'manual' as const, atHour: 4, idleMinutes: 60 },
      resetTriggers: ['/new', '/reset'],
      cleanup: { enabled: true, maxAgeDays: 30, idleDays: 14 },
    };
  }
}

