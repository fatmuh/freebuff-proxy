// ─── Primary Models ────────────────────────────────────────────
// These models own a session via the x-freebuff-model header.
// All other models (gemini, etc.) are "sub" models that ride on
// whichever session is active — no special handling needed.

export const PRIMARY_MODELS = new Set([
  'minimax/minimax-m2.7',
  'z-ai/glm-5.1',
])

export const DEFAULT_PRIMARY_MODEL = 'minimax/minimax-m2.7'

// Short alias → full upstream model ID
export const MODEL_ALIASES: Record<string, string> = {
  'minimax-m2.7': 'minimax/minimax-m2.7',
  'glm-5.1': 'z-ai/glm-5.1',
}

export function resolveModelId(model: string): string {
  return MODEL_ALIASES[model] ?? model
}

// ─── Config ───────────────────────────────────────────────────

export interface Config {
  listenAddr: string
  upstreamBaseURL: string
  rotationInterval: number     // ms
  requestTimeout: number        // ms
  httpProxy: string
  sessionIdleTimeout: number    // ms; 0 = keep session alive indefinitely
}

// ─── Session ──────────────────────────────────────────────────

export type SessionStatus =
  | 'disabled'
  | 'none'
  | 'queued'
  | 'active'
  | 'ended'
  | 'superseded'
  | 'model_locked'

export interface FreeSessionResponse {
  status: string
  instanceId: string
  model: string
  expiresAt: string
  remainingMs: number
  estimatedWaitMs: number
  gracePeriodRemainingMs: number
  message: string
  currentModel: string
  requestedModel: string
  position: number
  queueDepth: number
  queueDepthByModel: Record<string, number>
  admittedAt: string
  queuedAt: string
}

export interface CachedSession {
  status: SessionStatus
  instanceId: string
  model: string
  expiresAt: Date | null
  admittedAt: string | null
  remainingMs: number
  position: number
  queueDepth: number
  estimatedWaitMs: number
}

// ─── Run ──────────────────────────────────────────────────────

export interface ManagedRun {
  id: string
  agentId: string
  startedAt: Date
  inflight: number
  requestCount: number
  finishing: boolean
}

// ─── Snapshots (for /healthz and /admin/status) ──────────────

export interface TokenSnapshot {
  name: string
  sessionModel: string
  runs: RunSnapshot[]
  drainingRuns: number
  switching: boolean
  sessionStatus: string
  sessionInstanceId: string
  sessionExpiresAt: string | null
  sessionAdmittedAt: string | null
  sessionRemainingMs: number
  sessionPosition: number
  sessionQueueDepth: number
  sessionEstWaitMs: number
  cooldownUntil: string | null
  lastError: string
  paused: boolean
}

export interface RunSnapshot {
  agentId: string
  runId: string
  startedAt: string
  inflight: number
  requestCount: number
}

// ─── Binding ──────────────────────────────────────────────────

export interface Binding {
  apiKey: string
  model: string
  createdAt: string
}

export interface BindingStoreData {
  bindings: Binding[]
}

// ─── Model Registry ───────────────────────────────────────────

export interface ModelRegistryState {
  agentModels: Record<string, string[]>   // agentId → models[]
  modelToAgent: Record<string, string>    // model → agentId
  allModels: string[]
}
