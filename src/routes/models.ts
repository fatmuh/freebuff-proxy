import type { Context } from 'hono'
import type { ModelRegistry } from '../model-registry.js'

// GET /v1/models — OpenAI-compatible model list
export function handleModels(registry: ModelRegistry, startedAt: Date) {
  return (c: Context) => {
    const created = Math.floor(startedAt.getTime() / 1000)
    const modelsList = registry.models().map(model => ({
      id: model,
      object: 'model',
      created,
      owned_by: 'Freebuff2API',
      root: model,
      permission: [],
    }))

    return c.json({
      object: 'list',
      data: modelsList,
    })
  }
}
