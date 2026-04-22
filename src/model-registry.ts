import { UpstreamClient } from './upstream.js'
import type { ModelRegistryState } from './types.js'

// ─── Hardcoded Fallback ────────────────────────────────────────
// Used when remote fetch fails on startup (same as Go version)

const HARDCODED_FALLBACK: Record<string, string[]> = {
  'base2-free':         ['minimax/minimax-m2.7', 'z-ai/glm-5.1'],
  'file-picker':        ['google/gemini-2.5-flash-lite'],
  'file-picker-max':    ['google/gemini-3.1-flash-lite-preview'],
  'file-lister':        ['google/gemini-3.1-flash-lite-preview'],
  'researcher-web':     ['google/gemini-3.1-flash-lite-preview'],
  'researcher-docs':    ['google/gemini-3.1-flash-lite-preview'],
  'basher':             ['google/gemini-3.1-flash-lite-preview'],
  'editor-lite':        ['minimax/minimax-m2.7', 'z-ai/glm-5.1'],
  'code-reviewer-lite': ['minimax/minimax-m2.7', 'z-ai/glm-5.1'],
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
    return model in this.modelToAgent
  }

  agentForModel(model: string): string | undefined {
    return this.modelToAgent[model]
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

function parseAllFreeModels(source: string): Record<string, string[]> {
  const blockRe = /'([^']+)':\s*new\s+Set\(\[([^\]]*)\]\)/g
  const modelRe = /'([^']+)'/g

  const result: Record<string, string[]> = {}
  let blockMatch: RegExpExecArray | null

  while ((blockMatch = blockRe.exec(source)) !== null) {
    const agentId = blockMatch[1]
    const modelsStr = blockMatch[2]

    const models: string[] = []
    let modelMatch: RegExpExecArray | null
    modelRe.lastIndex = 0 // reset for each block

    while ((modelMatch = modelRe.exec(modelsStr)) !== null) {
      const model = modelMatch[1].trim()
      if (model) models.push(model)
    }

    if (models.length > 0) result[agentId] = models
  }

  return result
}

// Build model→agent reverse mapping. When a model appears in multiple
// agents, one is chosen at random (same as Go version).
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
    modelToAgent[model] = agents[Math.floor(Math.random() * agents.length)]
    allModels.push(model)
  }

  allModels.sort()
  return { modelToAgent, allModels }
}
