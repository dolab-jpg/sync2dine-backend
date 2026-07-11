export type MailProviderId = 'google' | 'microsoft' | 'yahoo' | 'nylas';

export type MailboxConnectionStatus = 'connected' | 'needs_reconnect' | 'error' | 'disconnected';

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  email?: string;
  scope?: string;
}

export interface MailProviderConfig {
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
}

export interface MailProviderAdapter {
  id: MailProviderId;
  buildAuthUrl(state: string, loginHint?: string): string;
  exchangeCode(code: string): Promise<TokenSet>;
  refreshToken(refreshToken: string): Promise<TokenSet>;
  revokeToken(refreshToken: string): Promise<void>;
  getConfig(): MailProviderConfig;
}

export interface MailboxConnection {
  id: string;
  orgId: string;
  userId: string;
  provider: MailProviderId;
  emailAddress: string;
  displayName?: string;
  status: MailboxConnectionStatus;
  connectedAt: string;
  lastSyncedAt?: string;
  lastError?: string;
}

export interface MailboxTokenRow {
  connectionId: string;
  accessTokenEnc: string;
  refreshTokenEnc: string;
  expiresAt: string;
  scope?: string;
  updatedAt: string;
}

export interface MailboxSyncState {
  connectionId: string;
  folder: string;
  lastUid: number;
  uidValidity?: number;
  lastSyncedAt?: string;
  lastError?: string;
  pollIntervalSec: number;
}

export interface CachedEmailMessage {
  id: string;
  connectionId: string;
  uid: number;
  messageId: string;
  threadId: string;
  subject: string;
  fromAddr: string;
  fromName?: string;
  toAddrs: string[];
  snippet: string;
  textBody?: string;
  htmlBody?: string;
  receivedAt: string;
  hasAttachments: boolean;
  inReplyTo?: string;
  syncedAt: string;
}

export interface CachedEmailAttachment {
  id: string;
  messageCacheId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storagePath?: string;
  contentId?: string;
}

export interface InboxThread {
  threadId: string;
  subject: string;
  participants: string[];
  lastMessageAt: string;
  snippet: string;
  unread: boolean;
  messageCount: number;
}

export interface SendMailboxPayload {
  connectionId: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  html?: string;
  attachments?: Array<{ filename: string; mimeType: string; content: string }>;
}

export interface OAuthStatePayload {
  userId: string;
  orgId: string;
  provider: MailProviderId;
  ts: number;
}
