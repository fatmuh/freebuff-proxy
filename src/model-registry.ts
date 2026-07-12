import { UpstreamClient } from './upstream.js'
import type { ModelRegistryState } from './types.js'
import { resolveModelId } from './types.js'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

// ─── Hardcoded Fallback ────────────────────────────────────────
// Used when remote fetch and disk cache both fail

const HARDCODED_FALLBACK: Record<string, string[]> = {
  'base2-free':               ['minimax/minimax-m2.7'],
  'base2-free-kimi':          ['moonshotai/kimi-k2.7-code'],
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
  'editor-lite':              [
    'deepseek/deepseek-v4-pro',
    'deepseek/deepseek-v4-flash',
    'moonshotai/kimi-k2.7-code',
    'minimax/minimax-m2.7',
    'minimax/minimax-m3',
    'mimo/mimo-v2.5',
    'mimo/mimo-v2.5-pro',
  ],
  'code-reviewer-lite':       [
    'deepseek/deepseek-v4-pro',
    'deepseek/deepseek-v4-flash',
    'moonshotai/kimi-k2.7-code',
    'minimax/minimax-m2.7',
    'minimax/minimax-m3',
    'mimo/mimo-v2.5',
    'mimo/mimo-v2.5-pro',
  ],
}

const FREE_AGENTS_SOURCE_URL =
  'https://raw.githubusercontent.com/CodebuffAI/codebuff/main/common/src/constants/free-agents.ts'
const FREEBUFF_MODELS_SOURCE_URL =
  'https://raw.githubusercontent.com/CodebuffAI/codebuff/main/common/src/constants/freebuff-models.ts'
const MODEL_CONFIG_SOURCE_URL =
  'https://raw.githubusercontent.com/CodebuffAI/codebuff/main/common/src/constants/model-config.ts'

const REFRESH_INTERVAL = 6 * 3600_000 // 6h
const DEFAULT_CACHE_PATH = resolve('data', 'model-registry-cache.json')

interface ModelRegistryCacheFile {
  savedAt: string
  agentModels: Record<string, string[]>
  premiumModels: string[]
  source: 'remote' | 'fallback'
}

// ─── Model Registry ────────────────────────────────────────────
// Fetches free-agents + freebuff-models from Codebuff GitHub.
// On failure: last successful in-memory state → disk cache → hardcoded.

export class ModelRegistry {
  private client: UpstreamClient
  private log: (...args: unknown[]) => void
  private cachePath: string

  private agentModels: Record<string, string[]> = {}
  private modelToAgent: Record<string, string> = {}
  private allModels: string[] = []
  private premiumModels = new Set<string>()
  private hasLiveState = false

  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private stopped = false

  constructor(
    client: UpstreamClient,
    log: (...args: unknown[]) => void,
    cachePath = DEFAULT_CACHE_PATH,
  ) {
    this.client = client
    this.log = log
    this.cachePath = cachePath
  }

  async start(): Promise<void> {
    try {
      await this.refresh()
    } catch (err) {
      this.log('model registry: initial fetch failed:', err)
      if (!(await this.loadDiskCache())) {
        this.loadFallback()
      }
    }

    this.refreshTimer = setInterval(() => {
      if (this.stopped) return
      this.refresh().catch(err => {
        this.log('model registry: refresh failed (keeping previous):', err)
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

  isPremiumModel(model: string): boolean {
    return this.premiumModels.has(resolveModelId(model))
  }

  premiumModelIds(): string[] {
    return [...this.premiumModels].sort()
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

  private async refresh(): Promise<void> {
    const [agentsSrc, modelsSrc, configSrc] = await Promise.all([
      this.client.fetchText(FREE_AGENTS_SOURCE_URL, 30_000),
      this.client.fetchText(FREEBUFF_MODELS_SOURCE_URL, 30_000).catch(() => ''),
      this.client.fetchText(MODEL_CONFIG_SOURCE_URL, 30_000).catch(() => ''),
    ])

    const varMap = {
      ...KNOWN_MODEL_VARS,
      ...parseModelConfigIds(configSrc),
      ...parseFreebuffModelConsts(modelsSrc),
    }

    const parsed = parseAllFreeModels(agentsSrc, varMap)
    if (Object.keys(parsed).length === 0) {
      throw new Error('no free agents found in source')
    }

    // Prefer live FREEBUFF_ROOT_AGENT_ID_BY_MODEL from free-agents source
    const liveRootMap = parseRootAgentByModel(agentsSrc, varMap)
    const rootMap = { ...FREEBUFF_ROOT_AGENT_BY_MODEL, ...liveRootMap }

    injectExtraModels(parsed, rootMap)

    const premium = parsePremiumModelIds(modelsSrc, varMap)
    const { modelToAgent, allModels } = buildModelMapping(parsed, rootMap)

    this.agentModels = parsed
    this.modelToAgent = modelToAgent
    this.allModels = allModels
    this.premiumModels = premium
    this.hasLiveState = true

    await this.saveDiskCache('remote')
    this.log(
      'model registry: updated',
      Object.keys(parsed).length,
      'agents,',
      allModels.length,
      'models:',
      allModels,
      'premium:',
      [...premium],
    )
  }

  private async loadDiskCache(): Promise<boolean> {
    try {
      const raw = await readFile(this.cachePath, 'utf-8')
      const data = JSON.parse(raw) as ModelRegistryCacheFile
      if (!data?.agentModels || Object.keys(data.agentModels).length === 0) return false

      const { modelToAgent, allModels } = buildModelMapping(
        data.agentModels,
        FREEBUFF_ROOT_AGENT_BY_MODEL,
      )
      this.agentModels = data.agentModels
      this.modelToAgent = modelToAgent
      this.allModels = allModels
      this.premiumModels = new Set(data.premiumModels ?? [])
      this.hasLiveState = true
      this.log(
        'model registry: loaded disk cache from',
        data.savedAt,
        `(${allModels.length} models)`,
      )
      return true
    } catch {
      return false
    }
  }

  private async saveDiskCache(source: 'remote' | 'fallback'): Promise<void> {
    try {
      const payload: ModelRegistryCacheFile = {
        savedAt: new Date().toISOString(),
        agentModels: this.agentModels,
        premiumModels: [...this.premiumModels],
        source,
      }
      await mkdir(dirname(this.cachePath), { recursive: true })
      await writeFile(this.cachePath, JSON.stringify(payload, null, 2))
    } catch (err) {
      this.log('model registry: disk cache write failed:', err)
    }
  }

  private loadFallback(): void {
    if (this.hasLiveState) return
    const { modelToAgent, allModels } = buildModelMapping(
      HARDCODED_FALLBACK,
      FREEBUFF_ROOT_AGENT_BY_MODEL,
    )
    this.agentModels = { ...HARDCODED_FALLBACK }
    this.modelToAgent = modelToAgent
    this.allModels = allModels
    this.premiumModels = new Set([
      'deepseek/deepseek-v4-pro',
      'mimo/mimo-v2.5-pro',
      'moonshotai/kimi-k2.7-code',
    ])
    this.hasLiveState = true
    void this.saveDiskCache('fallback')
    this.log('model registry: loaded hardcoded fallback models:', allModels)
  }
}

// ─── Parsing ──────────────────────────────────────────────────

/** Static known model var → id (overridden by live model-config / freebuff-models). */
const KNOWN_MODEL_VARS: Record<string, string> = {
  FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID: 'deepseek/deepseek-v4-pro',
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID: 'deepseek/deepseek-v4-flash',
  FREEBUFF_GEMINI_PRO_MODEL_ID: 'google/gemini-3.1-pro-preview',
  FREEBUFF_KIMI_MODEL_ID: 'moonshotai/kimi-k2.7-code',
  FREEBUFF_MINIMAX_MODEL_ID: 'minimax/minimax-m2.7',
  FREEBUFF_MINIMAX_M3_MODEL_ID: 'minimax/minimax-m3',
  FREEBUFF_MIMO_V25_MODEL_ID: 'mimo/mimo-v2.5',
  FREEBUFF_MIMO_V25_PRO_MODEL_ID: 'mimo/mimo-v2.5-pro',
  FREEBUFF_GLM_V52_MODEL_ID: 'z-ai/glm-5.2',
  FREEBUFF_HY3_MODEL_ID: 'tencent/hy3:free',
  FREEBUFF_HY3_ATLAS_MODEL_ID: 'tencent/hy3',
  FREEBUFF_KAT_CODER_PRO_V2_MODEL_ID: 'kwaipilot/kat-coder-pro-v2',
}

const FREEBUFF_ROOT_AGENT_BY_MODEL: Record<string, string> = {
  'minimax/minimax-m2.7': 'base2-free',
  'minimax/minimax-m3': 'base2-free-minimax-m3',
  'moonshotai/kimi-k2.6': 'base2-free-kimi',
  'moonshotai/kimi-k2.7-code': 'base2-free-kimi',
  'deepseek/deepseek-v4-pro': 'base2-free-deepseek',
  'deepseek/deepseek-v4-flash': 'base2-free-deepseek-flash',
  'mimo/mimo-v2.5': 'base2-free-mimo',
  'mimo/mimo-v2.5-pro': 'base2-free-mimo-pro',
  'z-ai/glm-5.2': 'base2-free-glm',
}

function injectExtraModels(
  parsed: Record<string, string[]>,
  rootMap: Record<string, string>,
): void {
  for (const [model, agentId] of Object.entries(rootMap)) {
    const alreadyPresent = Object.values(parsed).some(models => models.includes(model))
    if (!alreadyPresent) {
      if (!parsed[agentId]) parsed[agentId] = []
      if (!parsed[agentId].includes(model)) {
        parsed[agentId].push(model)
      }
    }
  }
}

function parseAllFreeModels(
  source: string,
  varMap: Record<string, string>,
): Record<string, string[]> {
  const result: Record<string, string[]> = {}

  // Pattern 1: 'agent': new Set([ ... ])
  const literalRe = /'([^']+)':\s*new\s+Set\(\[([^\]]*)\]\)/g
  // Pattern 2: 'agent': new Set(IDENTIFIER)
  const refRe = /'([^']+)':\s*new\s+Set\((\w+)\)/g
  // Pattern 3: [CONST]: new Set([ ... ])  e.g. desktop thread agent
  const bracketLiteralRe = /\[(\w+)\]:\s*new\s+Set\(\[([^\]]*)\]\)/g

  let blockMatch: RegExpExecArray | null

  while ((blockMatch = literalRe.exec(source)) !== null) {
    const agentId = blockMatch[1]
    const models = extractModelsFromString(blockMatch[2], varMap)
    if (models.length > 0) result[agentId] = models
  }

  while ((blockMatch = bracketLiteralRe.exec(source)) !== null) {
    // Skip non-agent const keys; only keep if models resolved
    const models = extractModelsFromString(blockMatch[2], varMap)
    if (models.length > 0) {
      // Desktop thread uses a const name — map under a stable free root id if present
      const key = blockMatch[1]
      if (key.includes('DESKTOP') || key.includes('THREAD')) {
        result['freebuff-desktop-thread'] = models
      }
    }
  }

  while ((blockMatch = refRe.exec(source)) !== null) {
    const agentId = blockMatch[1]
    const varName = blockMatch[2]
    // Resolve known multi-model set names if we ever add them
    if (varName === 'FREEBUFF_ALLOWED_MODEL_IDS') {
      result[agentId] = Object.values(varMap).filter(v => v.includes('/'))
    }
  }

  return result
}

function extractModelsFromString(str: string, varMap: Record<string, string>): string[] {
  const models: string[] = []
  const modelRe = /'([^']+)'/g
  let match: RegExpExecArray | null

  while ((match = modelRe.exec(str)) !== null) {
    const model = match[1].trim()
    if (model) models.push(model)
  }

  for (const [varName, modelId] of Object.entries(varMap)) {
    if (str.includes(varName) && !models.includes(modelId)) {
      models.push(modelId)
    }
  }

  return models
}

/** Parse moonshotModels.kimiK27Code etc. from model-config.ts */
function parseModelConfigIds(source: string): Record<string, string> {
  if (!source) return {}
  const out: Record<string, string> = {}

  // kimiK27Code: 'moonshotai/kimi-k2.7-code'
  const entryRe = /(\w+)\s*:\s*'([^']+\/[^']+)'/g
  let m: RegExpExecArray | null
  while ((m = entryRe.exec(source)) !== null) {
    const key = m[1]
    const id = m[2]
    if (key === 'kimiK27Code') out.FREEBUFF_KIMI_MODEL_ID = id
    if (key === 'kimiK26' && !out.FREEBUFF_KIMI_MODEL_ID) {
      // only fallback if k2.7 not found later — applied after full scan
      out.__KIMI_K26 = id
    }
    if (key === 'minimaxM3') out.FREEBUFF_MINIMAX_M3_MODEL_ID = id
    if (key === 'mimoV25') out.FREEBUFF_MIMO_V25_MODEL_ID = id
    if (key === 'mimoV25Pro') out.FREEBUFF_MIMO_V25_PRO_MODEL_ID = id
  }

  if (!out.FREEBUFF_KIMI_MODEL_ID && out.__KIMI_K26) {
    out.FREEBUFF_KIMI_MODEL_ID = out.__KIMI_K26
  }
  delete out.__KIMI_K26
  return out
}

/** Parse export const FREEBUFF_*_MODEL_ID = '...' or = otherConst */
function parseFreebuffModelConsts(source: string): Record<string, string> {
  if (!source) return {}
  const out: Record<string, string> = {}

  // Direct string: export const FREEBUFF_X = 'provider/model'
  const directRe = /export\s+const\s+(FREEBUFF_\w+_MODEL_ID)\s*=\s*'([^']+)'/g
  let m: RegExpExecArray | null
  while ((m = directRe.exec(source)) !== null) {
    out[m[1]] = m[2]
  }

  // Alias: export const FREEBUFF_KIMI_MODEL_ID = moonshotModels.kimiK27Code
  // Already handled via model-config; also catch string after resolve chains later
  return out
}

function parsePremiumModelIds(
  modelsSrc: string,
  varMap: Record<string, string>,
): Set<string> {
  const premium = new Set<string>()
  if (!modelsSrc) {
    premium.add('deepseek/deepseek-v4-pro')
    premium.add('mimo/mimo-v2.5-pro')
    premium.add(varMap.FREEBUFF_KIMI_MODEL_ID ?? 'moonshotai/kimi-k2.7-code')
    return premium
  }

  // export const FREEBUFF_PREMIUM_MODEL_IDS = [ A, B, C ] as const
  const blockRe = /FREEBUFF_PREMIUM_MODEL_IDS\s*=\s*\[([^\]]*)\]/s
  const block = blockRe.exec(modelsSrc)
  if (!block) {
    premium.add('deepseek/deepseek-v4-pro')
    premium.add('mimo/mimo-v2.5-pro')
    premium.add(varMap.FREEBUFF_KIMI_MODEL_ID ?? 'moonshotai/kimi-k2.7-code')
    return premium
  }

  const body = block[1]
  // string literals
  const litRe = /'([^']+)'/g
  let lm: RegExpExecArray | null
  while ((lm = litRe.exec(body)) !== null) premium.add(lm[1])

  // const refs
  for (const [varName, modelId] of Object.entries(varMap)) {
    if (body.includes(varName)) premium.add(modelId)
  }

  return premium
}

function parseRootAgentByModel(
  agentsSrc: string,
  varMap: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  // [FREEBUFF_KIMI_MODEL_ID]: 'base2-free-kimi',
  const re = /\[(\w+)\]\s*:\s*'([^']+)'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(agentsSrc)) !== null) {
    const modelId = varMap[m[1]]
    if (modelId && m[2].startsWith('base2-free')) {
      out[modelId] = m[2]
    }
  }
  // 'literal/model': 'base2-free-...'
  const litRe = /'([^']+\/[^']+)'\s*:\s*'(base2-free[^']*)'/g
  while ((m = litRe.exec(agentsSrc)) !== null) {
    out[m[1]] = m[2]
  }
  return out
}

function buildModelMapping(
  agentModels: Record<string, string[]>,
  rootMap: Record<string, string>,
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
    modelToAgent[model] = rootAgentForModel(model, agents, rootMap) ?? agents[0]
    allModels.push(model)
  }

  allModels.sort()
  return { modelToAgent, allModels }
}

function rootAgentForModel(
  model: string,
  agents: string[],
  rootMap: Record<string, string>,
): string | undefined {
  const preferred = rootMap[model]
  if (preferred && agents.includes(preferred)) return preferred
  return agents.find(agent => agent.startsWith('base2-free'))
}
