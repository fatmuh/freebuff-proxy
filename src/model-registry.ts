import { UpstreamClient } from './upstream.js'
import type { ModelRegistryState } from './types.js'
import { resolveModelId } from './types.js'

// ─── Hardcoded Fallback ────────────────────────────────────────
// Used when remote fetch fails on startup (same as Go version)

const HARDCODED_FALLBACK: Record<string, string[]> = {
  'base2-free':               ['minimax/minimax-m2.7'],
  'base2-free-kimi':          ['moonshotai/kimi-k2.6'],
  'base2-free-deepseek':      ['deepseek/deepseek-v4-pro'],
  'base2-free-deepseek-flash':['deepseek/deepseek-v4-flash'],
  'base2-free-minimax-m3':    ['minimax/minimax-m3'],
  'base2-free-mimo':          ['mimo/mimo-v2.5'],
  'base2-free-mimo-pro':      ['mimo/mimo-v2.5-pro'],
  'file-picker':              ['google/gemini-2.5-flash-lite'],
  'file-picker-max':          ['google/gemini-3.1-flash-lite-preview'],
  'file-lister':              ['google/gemini-3.1-flash-lite-preview'],
  'researcher-web':           ['google/gemini-3.1-flash-lite-preview'],
  'researcher-docs':          ['google/gemini-3.1-flash-lite-preview'],
  'basher':                   ['google/gemini-3.1-flash-lite-preview'],
  'editor-lite':              ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash', 'moonshotai/kimi-k2.6', 'minimax/minimax-m2.7', 'minimax/minimax-m3', 'mimo/mimo-v2.5', 'mimo/mimo-v2.5-pro'],
  'code-reviewer-lite':       ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash', 'moonshotai/kimi-k2.6', 'minimax/minimax-m2.7', 'minimax/minimax-m3', 'mimo/mimo-v2.5', 'mimo/mimo-v2.5-pro'],
}

const FREE_AGENTS_SOURCE_URL =
  'https://raw.githubusercontent.com/CodebuffAI/codebuff/main/common/src/constants/free-agents.ts'

const REFRESH_INTERVAL = 6 * 3600_000 // 6h in ms

// ─── Model Registry ────────────────────────────────────────────
// Fetches and caches the agent→model mapping from free-agents.ts

export class ModelRegistry {
  private client: UpstreamClient
  private log: (...args: unknown[]) => void

  private agentModels: Record<string, string[]> = {}
  private modelToAgent: Record<string, string> = {}
  private allModels: string[] = []

  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private stopped = false

  constructor(client: UpstreamClient, log: (...args: unknown[]) => void) {
    this.client = client
    this.log = log
  }

  // ─── Lifecycle ───────────────────────────────────────────────

  async start(): Promise<void> {
    try {
      await this.refresh()
    } catch (err) {
      this.log('model registry: initial fetch failed, loading fallback:', err)
      this.loadFallback()
    }

    this.refreshTimer = setInterval(() => {
      if (this.stopped) return
      this.refresh().catch(err => {
        this.log('model registry: refresh failed:', err)
      })
    }, REFRESH_INTERVAL)
  }

  stop(): void {
    this.stopped = true
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
  }

  // ─── Public Queries ──────────────────────────────────────────

  models(): string[] {
    return [...this.allModels]
  }

  hasModel(model: string): boolean {
    const resolved = resolveModelId(model)
    return resolved in this.modelToAgent
  }

  agentForModel(model: string): string | undefined {
    const resolved = resolveModelId(model)
    return this.modelToAgent[resolved]
  }

  agentIds(): string[] {
    return Object.keys(this.agentModels)
  }

  state(): ModelRegistryState {
    return {
      agentModels: { ...this.agentModels },
      modelToAgent: { ...this.modelToAgent },
      allModels: [...this.allModels],
    }
  }

  // ─── Internal ────────────────────────────────────────────────

  private async refresh(): Promise<void> {
    const source = await this.client.fetchText(FREE_AGENTS_SOURCE_URL, 30_000)
    const parsed = parseAllFreeModels(source)
    if (Object.keys(parsed).length === 0) {
      throw new Error('no free agents found in source')
    }

    // Merge in models that exist upstream but aren't in free-agents.ts yet
    injectExtraModels(parsed)

    const { modelToAgent, allModels } = buildModelMapping(parsed)
    this.agentModels = parsed
    this.modelToAgent = modelToAgent
    this.allModels = allModels

    this.log('model registry: updated', Object.keys(parsed).length, 'agents,', allModels.length, 'models:', allModels)
  }

  private loadFallback(): void {
    const { modelToAgent, allModels } = buildModelMapping(HARDCODED_FALLBACK)
    this.agentModels = { ...HARDCODED_FALLBACK }
    this.modelToAgent = modelToAgent
    this.allModels = allModels
    this.log('model registry: loaded fallback models:', allModels)
  }
}

// ─── Parsing ──────────────────────────────────────────────────
// Extracts agent→models from the free-agents.ts TypeScript source

const KNOWN_MODEL_VARS: Record<string, string> = {
  FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID: 'deepseek/deepseek-v4-pro',
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID: 'deepseek/deepseek-v4-flash',
  FREEBUFF_GEMINI_PRO_MODEL_ID: 'google/gemini-3.1-pro-preview',
  FREEBUFF_KIMI_MODEL_ID: 'moonshotai/kimi-k2.6',
  FREEBUFF_MINIMAX_MODEL_ID: 'minimax/minimax-m2.7',
  FREEBUFF_MINIMAX_M3_MODEL_ID: 'minimax/minimax-m3',
  FREEBUFF_MIMO_V25_MODEL_ID: 'mimo/mimo-v2.5',
  FREEBUFF_MIMO_V25_PRO_MODEL_ID: 'mimo/mimo-v2.5-pro',
}

const KNOWN_MODEL_SETS: Record<string, string[]> = {
  FREEBUFF_ALLOWED_MODEL_IDS: [
    'deepseek/deepseek-v4-pro',
    'deepseek/deepseek-v4-flash',
    'moonshotai/kimi-k2.6',
    'minimax/minimax-m2.7',
    'minimax/minimax-m3',
    'mimo/mimo-v2.5',
    'mimo/mimo-v2.5-pro',
  ],
}

const FREEBUFF_ROOT_AGENT_BY_MODEL: Record<string, string> = {
  'minimax/minimax-m2.7': 'base2-free',
  'minimax/minimax-m3': 'base2-free-minimax-m3',
  'moonshotai/kimi-k2.6': 'base2-free-kimi',
  'deepseek/deepseek-v4-pro': 'base2-free-deepseek',
  'deepseek/deepseek-v4-flash': 'base2-free-deepseek-flash',
  'mimo/mimo-v2.5': 'base2-free-mimo',
  'mimo/mimo-v2.5-pro': 'base2-free-mimo-pro',
}

/**
 * Inject models from FREEBUFF_ROOT_AGENT_BY_MODEL that aren't already in the
 * parsed agent→models map. This covers models that exist on Codebuff's
 * upstream API but aren't listed in the open-source free-agents.ts yet.
 */
function injectExtraModels(parsed: Record<string, string[]>): void {
  for (const [model, agentId] of Object.entries(FREEBUFF_ROOT_AGENT_BY_MODEL)) {
    const alreadyPresent = Object.values(parsed).some(models => models.includes(model))
    if (!alreadyPresent) {
      if (!parsed[agentId]) parsed[agentId] = []
      if (!parsed[agentId].includes(model)) {
        parsed[agentId].push(model)
      }
    }
  }
}

function parseAllFreeModels(source: string): Record<string, string[]> {
  const result: Record<string, string[]> = {}

  // Pattern 1: new Set([...]) with literal array
  const literalRe = /'([^']+)':\s*new\s+Set\(\[([^\]]*)\]\)/g
  // Pattern 2: new Set(IDENTIFIER) - full reference to a variable
  const refRe = /'([^']+)':\s*new\s+Set\((\w+)\)/g

  let blockMatch: RegExpExecArray | null

  // Handle literal arrays
  while ((blockMatch = literalRe.exec(source)) !== null) {
    const agentId = blockMatch[1]
    const modelsStr = blockMatch[2]
    const models = extractModelsFromString(modelsStr)
    if (models.length > 0) result[agentId] = models
  }

  // Handle variable references (full set like FREEBUFF_ALLOWED_MODEL_IDS)
  while ((blockMatch = refRe.exec(source)) !== null) {
    const agentId = blockMatch[1]
    const varName = blockMatch[2]
    const models = KNOWN_MODEL_SETS[varName]
    if (models) result[agentId] = models
  }

  return result
}

function extractModelsFromString(str: string): string[] {
  const models: string[] = []
  const modelRe = /'([^']+)'/g
  let match: RegExpExecArray | null

  while ((match = modelRe.exec(str)) !== null) {
    const model = match[1].trim()
    if (model) models.push(model)
  }

  // Also resolve known variable references in arrays
  for (const [varName, modelId] of Object.entries(KNOWN_MODEL_VARS)) {
    if (str.includes(varName) && !models.includes(modelId)) {
      models.push(modelId)
    }
  }

  return models
}

// Build model→agent reverse mapping for direct client requests. Codebuff's
// free gate requires these requests to use a root freebuff agent, not one of
// the subagents that is also allowlisted for the same model.
function buildModelMapping(
  agentModels: Record<string, string[]>,
): { modelToAgent: Record<string, string>; allModels: string[] } {
  const modelAgents: Record<string, string[]> = {}
  for (const [agentId, models] of Object.entries(agentModels)) {
    for (const model of models) {
      if (!modelAgents[model]) modelAgents[model] = []
      modelAgents[model].push(agentId)
    }
  }

  const modelToAgent: Record<string, string> = {}
  const allModels: string[] = []

  for (const [model, agents] of Object.entries(modelAgents)) {
    modelToAgent[model] = rootAgentForModel(model, agents) ?? agents[0]
    allModels.push(model)
  }

  allModels.sort()
  return { modelToAgent, allModels }
}

function rootAgentForModel(model: string, agents: string[]): string | undefined {
  const preferred = FREEBUFF_ROOT_AGENT_BY_MODEL[model]
  if (preferred && agents.includes(preferred)) return preferred
  return agents.find(agent => agent.startsWith('base2-free'))
}
