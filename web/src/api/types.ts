/**
 * Response and request shapes of the Content Radar app API (`src/app/api/*.js`).
 * Enumerations the UI renders as lists come from `GET /api/meta`; the literal
 * unions below are the values the UI branches on.
 */

export type Role = 'viewer' | 'operator';

export type Identity =
  | { readonly type: 'user'; readonly email: string }
  | { readonly type: 'service'; readonly clientId: string };

export interface Me {
  identity: Identity | null;
  role: Role | null;
}

export interface Health {
  status: string;
  version: string;
  time: string;
  runtime: {
    active: boolean;
    leased: boolean;
    leaseHolder: { id: string; self: boolean; expiresAt: string } | null;
    running: boolean;
    queued: number;
    scheduledChannels: number;
  };
  channelCount: number;
}

/** A field problem of a `validation_failed` error; `field` is a dotted path such as `sources.0.config.url`. */
export interface ApiIssue {
  field: string;
  code: string;
  message: string;
}

export interface ApiErrorBody {
  error: string;
  message: string;
  issues?: ApiIssue[];
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Meta (`GET /api/meta`)

export type Requirement = 'required' | 'optional' | 'none';
export type FieldKind = 'text' | 'url' | 'integer' | 'enum' | 'jsonPath' | 'jsonFields';

export interface FieldSpec {
  key: string;
  kind: FieldKind;
  required: boolean;
  maxLength?: number;
  pattern?: string;
  min?: number;
  max?: number;
  options?: string[];
  fields?: FieldSpec[];
}

export interface PresetMeta {
  id: string;
  sources: { id: string; name: string }[];
}

export interface SourceTypeMeta {
  type: string;
  fields: FieldSpec[];
}

export interface AiProviderMeta {
  id: string;
  apiKey: Requirement;
  baseUrl: Requirement;
  customName: boolean;
  gateway: { apiKey: Requirement; tokenRequired: boolean; fields: FieldSpec[] } | null;
}

export const LIMIT_KEYS = ['dailyLimit', 'batchSize', 'maxArticles', 'maxArticlesPerSource', 'concurrency', 'delayMs'] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];

export interface Meta {
  channel: {
    platforms: string[];
    modes: ChannelMode[];
    idPattern: string;
    idMaxLength: number;
    nameMaxLength: number;
    cronMaxLength: number;
  };
  sources: { maxEntries: number; presets: PresetMeta[]; types: SourceTypeMeta[] };
  ai: {
    providers: AiProviderMeta[];
    modelMaxLength: number;
    modelPattern: string;
    nameMaxLength: number;
    baseUrlMaxLength: number;
  };
  prompt: {
    languages: string[];
    styles: string[];
    defaultLanguage: string;
    defaultStyle: string;
    audienceMaxLength: number;
    customSystemPromptMaxLength: number;
  };
  limits: {
    ranges: Record<LimitKey, { min: number; max: number }>;
    defaults: ChannelLimits;
    /** Upper bound of `batchSize × delayMs` (reported on `limits.delayMs`). */
    maxBatchDelayMs: number;
  };
  credentials: {
    kinds: CredentialKind[];
    slots: { field: string; kind: CredentialKind }[];
    labelMaxLength: number;
    valueMaxLength: number;
  };
  controls: { actions: ControlAction[]; reasonMaxLength: number };
  runs: { statuses: RunStatus[]; triggerTypes: TriggerType[]; maxPageSize: number };
  content: { statuses: ContentStatus[]; rejectReasons: string[]; dateFields: ContentDateField[]; maxPageSize: number };
  stats: { maxRangeDays: number };
}

// ---------------------------------------------------------------------------
// Channels (`/api/channels`)

export type ChannelMode = 'digest' | 'drip';

export interface PresetSourceEntry {
  type: 'preset';
  preset: string;
  enabled: boolean;
}

/** Config values of a typed source: text, integers, or the JSON source's `fields` path mapping. */
export type SourceConfigValue = string | number | Record<string, string>;

export interface TypedSourceEntry {
  type: string;
  enabled: boolean;
  config: Record<string, SourceConfigValue>;
}

export type SourceEntry = PresetSourceEntry | TypedSourceEntry;

export function isPresetEntry(entry: SourceEntry): entry is PresetSourceEntry {
  return entry.type === 'preset';
}

export interface ChannelPrompt {
  language: string;
  style: string;
  audience: string;
  customSystemPrompt: string | null;
}

export interface ChannelGateway {
  accountId: string;
  gatewayId: string;
  byokAlias: string | null;
  tokenCredentialId: string | null;
}

export interface ChannelAI {
  provider: string;
  model: string | null;
  name: string | null;
  baseUrl: string | null;
  apiKeyCredentialId: string | null;
  gateway: ChannelGateway | null;
}

export interface ChannelTelegram {
  botTokenCredentialId: string | null;
  chatIdCredentialId: string | null;
}

export type ChannelLimits = Record<LimitKey, number>;

export interface ChannelConfig {
  id: string;
  name: string;
  enabled: boolean;
  platform: 'telegram';
  mode: ChannelMode;
  cron: string;
  timezone: string;
  notBefore: string | null;
  sources: SourceEntry[];
  prompt: ChannelPrompt;
  ai: ChannelAI;
  telegram: ChannelTelegram;
  limits: ChannelLimits;
}

export interface ChannelRecord extends ChannelConfig {
  version: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
  /**
   * Read-only system state (the seeded channel, created to take over from the
   * retired Cloudflare Worker): while `notBefore` is unset the server refuses resume,
   * manual runs, and output retries with 409 `cutover_required`.
   */
  cutoverRequired: boolean;
}

/** `POST /api/channels` body; new channels are created paused. */
export type ChannelInput = Omit<ChannelConfig, 'platform'> & { platform?: 'telegram' };

/** `PUT /api/channels/:id` body: changed top-level fields plus the current config `version`. */
export type ChannelUpdate = Partial<Omit<ChannelConfig, 'id'>> & { version: number };

// ---------------------------------------------------------------------------
// Credentials (`/api/credentials`) — metadata only, values are write-only.

export type CredentialKind = 'telegram_bot_token' | 'telegram_chat_id' | 'ai_api_key' | 'ai_gateway_token';

export interface Credential {
  id: string;
  label: string;
  kind: CredentialKind;
  isSet: boolean;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
  usedBy: string[];
}

export interface CredentialInput {
  label: string;
  kind: CredentialKind;
  value: string;
}

// ---------------------------------------------------------------------------
// Operations (`/api/channels/:id/...`, `/api/runs/:id`)

export type RunStatus = 'running' | 'success' | 'partial' | 'failed' | 'ambiguous' | 'skipped' | 'error' | 'interrupted';
export type TriggerType = 'scheduled' | 'manual';

export type SelectionStats = Partial<Record<'fetched' | 'fresh' | 'uncovered' | 'relevant' | 'ranked' | 'enqueued', number>>;

export interface SourceHealthSummary {
  total: number | null;
  healthy: number | null;
  failed: number | null;
  unknown: number | null;
  degraded: boolean;
}

export interface SourceHealthEntry {
  sourceId: string;
  sourceName: string | null;
  status: 'healthy' | 'empty' | 'failed';
  articleCount: number;
  errorClass: string | null;
}

export interface LastRunSummary {
  id: string;
  triggerType: TriggerType;
  status: RunStatus;
  reason: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  aiInputTokens: number | null;
  aiOutputTokens: number | null;
  outputsTotal: number | null;
  outputsSucceeded: number | null;
  outputsFailed: number | null;
  selection: SelectionStats | null;
  sourceHealth: SourceHealthSummary | null;
}

export interface QueueCounts {
  date: string;
  total: number;
  remaining: number;
  blocked: number;
  delivered: number;
}

export interface ChannelStatus {
  channelId: string;
  name: string;
  enabled: boolean;
  mode: ChannelMode;
  cron: string;
  timezone: string;
  notBefore: string | null;
  /** See `ChannelRecord.cutoverRequired`. */
  cutoverRequired: boolean;
  dailyLimit: number;
  /** Config version, for `PUT /api/channels/:id`. */
  configVersion: number;
  paused: boolean | null;
  /** Delivery-state version, the `expectedVersion` of pause/resume. */
  version: number | null;
  mutationState: string | null;
  allowedActions: ControlAction[];
  scheduled: boolean;
  running: boolean;
  queued: boolean;
  queue: QueueCounts;
  lastRun: LastRunSummary | null;
  unresolvedCount: number;
}

export interface QueueItem {
  position: number;
  deliveryId: string;
  status: ContentStatus;
  deliveryState: string;
  title: string | null;
  url: string | null;
  source: string | null;
  articleCount: number;
  forced: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface QueueView extends QueueCounts {
  mode: ChannelMode;
  items: QueueItem[];
}

export interface Page {
  limit: number;
  offset: number;
  total: number;
}

export interface PageQuery {
  limit?: number;
  offset?: number;
}

export interface RecoveryTarget {
  kind: 'delivery' | 'output' | 'outbox';
  deliveryId?: string;
  outputKey?: string;
  outboxId?: string;
  state: string;
  expectedVersion: number;
  allowedActions: ControlAction[];
  title?: string | null;
  articleCount?: number;
  mode?: ChannelMode | null;
  publishingDay?: string | null;
}

export interface UnresolvedView {
  channel: { channelId: string; state: 'paused' | 'active'; expectedVersion: number; allowedActions: ControlAction[] } | null;
  targets: RecoveryTarget[];
  page: Page;
}

export interface OutputResultRecord {
  deliveryId: string | null;
  outputId: string | null;
  success: boolean;
  deliveryState: string | null;
  messageIds: string[];
  error: string | null;
}

export interface RunStats {
  reason?: string | null;
  mode?: ChannelMode;
  publishingDay?: string | null;
  deliveryId?: string | null;
  deliveryState?: string | null;
  articles?: number | null;
  remaining?: number | null;
  blocked?: number | null;
  engineDurationMs?: number | null;
  selection?: SelectionStats | null;
  sourceHealth?: SourceHealthSummary | null;
  generation?: { attempted: number; succeeded: number; failed: number };
  outputs?: { total: number; succeeded: number; failed: number };
  outputResults?: OutputResultRecord[];
  items?: { deliveryId: string | null; title: string | null; status: string | null; reason: string | null; deliveryState: string | null }[];
  scanError?: string | null;
  requestedAt?: string;
  triggeredBy?: string | null;
  detailTruncated?: boolean;
}

export interface RunRecord {
  id: string;
  channelId: string;
  triggerType: TriggerType;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  stats: RunStats | null;
  aiInputTokens: number | null;
  aiOutputTokens: number | null;
  outputsTotal: number | null;
  outputsSucceeded: number | null;
  outputsFailed: number | null;
  error: string | null;
}

export interface RunDetail extends RunRecord {
  sourceHealth: (SourceHealthEntry & { observedAt: string })[];
}

export interface RunPage {
  runs: RunRecord[];
  page: Page;
}

export interface RunQueued {
  status: 'queued';
  channelId: string;
  runId: string;
  position: number;
}

export interface PreviewResult {
  channelId: string;
  status: string;
  reason: string | null;
  mode: ChannelMode;
  publishingDay: string | null;
  content: string | null;
  items: { title: string | null; hook: string | null }[];
  stats: { articles: number | null; sources: number | null; durationMs: number | null; selection: SelectionStats | null };
  sourceHealth: SourceHealthSummary | null;
  sources: SourceHealthEntry[];
  aiUsage: { attempted: number; succeeded: number; failed: number; inputTokens: number | null; outputTokens: number | null };
}

export type ControlAction =
  | 'pause'
  | 'resume'
  | 'retry-generation'
  | 'retry-output'
  | 'restore-topology'
  | 'confirm-delivered'
  | 'abandon'
  | 'retry-maintenance';

export interface ControlParams {
  idempotencyKey: string;
  expectedVersion: number;
  reason: string;
  deliveryId?: string;
  outputKey?: string;
  outboxId?: string;
  messageId?: string;
  confirmPausedMutation?: boolean;
  confirmDuplicateRisk?: boolean;
}

export interface ControlResult {
  channelId: string | null;
  action: string | null;
  status: string;
  replayed: boolean;
  paused?: boolean;
  version?: number;
  deliveryId?: string;
  deliveryState?: string;
  outboxId?: string;
  outboxState?: string;
}

// ---------------------------------------------------------------------------
// Content library (`/api/content`)

export type ContentStatus =
  | 'selected'
  | 'rejected'
  | 'queued'
  | 'generating'
  | 'delivering'
  | 'delivered'
  | 'generation_failed'
  | 'failed'
  | 'ambiguous'
  | 'blocked'
  | 'abandoned';

export type ContentDateField = 'seen' | 'published' | 'delivered';

export interface ContentQuery extends PageQuery {
  channelId?: string;
  status?: ContentStatus[];
  source?: string;
  dateField?: ContentDateField;
  /** Inclusive ISO instant. */
  from?: string;
  /** Exclusive ISO instant. */
  to?: string;
  keyword?: string;
}

export interface ContentItem {
  id: string;
  channelId: string;
  articleKey: string;
  title: string | null;
  url: string | null;
  sourceId: string | null;
  sourceName: string | null;
  category: string | null;
  publishedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  status: ContentStatus;
  rejectReason: string | null;
  deliveryId: string | null;
  messageId: string | null;
  deliveredAt: string | null;
  runId: string | null;
  updatedAt: string;
  summaryPreview?: string | null;
  summaryText?: string | null;
}

export interface ContentPage {
  items: ContentItem[];
  page: Page;
}

// ---------------------------------------------------------------------------
// Statistics (`/api/stats`)

export interface StatsQuery {
  /** Inclusive ISO instant. */
  from: string;
  /** Exclusive ISO instant, at most `meta.stats.maxRangeDays` after `from`. */
  to: string;
  channelId?: string;
  /** Day boundary offset; defaults to Vietnam time (420). */
  utcOffsetMinutes?: number;
}

export interface Stats {
  range: { from: string; to: string; channelId: string | null; utcOffsetMinutes: number };
  postsPerDay: { day: string; channelId: string; posts: number }[];
  sourceHealthPerDay: { day: string; sourceId: string; sourceName: string | null; healthy: number; empty: number; failed: number; articles: number }[];
  failureRatesPerDay: {
    day: string;
    runs: number;
    failedRuns: number;
    generationAttempts: number;
    generationFailures: number;
    generationFailureRate: number | null;
    outputAttempts: number;
    outputFailures: number;
    outputFailureRate: number | null;
  }[];
  tokenUsagePerDay: { day: string; inputTokens: number; outputTokens: number; totalTokens: number }[];
}

// ---------------------------------------------------------------------------
// Server-sent events (`/api/events`)

export type LiveEventType = 'connected' | 'run.started' | 'run.finished' | 'control.applied' | 'channel.changed' | 'credential.changed';

export interface LiveEvent {
  type: LiveEventType | string;
  at: string;
  data: Record<string, string | number | boolean | null>;
}
