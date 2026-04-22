import type { Context } from 'hono'
import { Readable } from 'node:stream'
import type { Dispatcher } from 'undici'
import type { RunManager } from '../run-manager.js'
import type { ModelRegistry } from '../model-registry.js'
import type { BindingStore } from '../binding-store.js'
import { normalizeToolSchemas } from '../schema-normalize.js'
import { openAIError, isSessionInvalid, isRunInvalid, extractUpstreamError, generateClientSessionId } from '../utils.js'

// POST /v1/chat/completions — main proxy endpoint
export function handleChatCompletions(
  registry: ModelRegistry,
  runs: RunManager,
  bindings: BindingStore,
) {
  return async (c: Context) => {
    if (c.req.method !== 'POST') {
      return openAIError(405, 'method not allowed', 'invalid_request_error')
    }

    // Parse request body
    let payload: Record<string, unknown>
    try {
      payload = await c.req.json()
    } catch {
      return openAIError(400, 'request body must be valid JSON', 'invalid_request_error')
    }

    const requestedModel = String(payload.model ?? '').trim()
    if (!requestedModel) {
      return openAIError(400, 'model is required', 'invalid_request_error')
    }

    // Lookup agent for this model
    const agentId = registry.agentForModel(requestedModel)
    if (!agentId) {
      return openAIError(400, `unsupported model "${requestedModel}"`, 'invalid_request_error', 'model_not_found')
    }

    // Determine primary model via binding
    const apiKey = c.get('apiKey') as string | undefined
    const primaryModel = apiKey ? bindings.get(apiKey) : 'minimax/minimax-m2.7'

    const startTime = Date.now()
    console.log(`[chat] incoming: model=${requestedModel} agentId=${agentId} primary=${primaryModel}`)

    // Retry loop (max 2 attempts, same as Go)
    for (let attempt = 0; attempt < 2; attempt++) {
      let lease
      try {
        lease = await runs.acquire(primaryModel, agentId, requestedModel)
      } catch (err) {
        console.log(`[chat] acquire failed: attempt=${attempt} err=${err}`)
        return openAIError(502, 'no healthy upstream auth token available', 'server_error')
      }

      console.log(`[${lease.pool.name}] routing request (model: ${requestedModel}) via run: ${lease.run.id}`)

      // Inject upstream metadata
      const upstreamBody = injectUpstreamMetadata(
        payload,
        requestedModel,
        lease.run.id,
        lease.pool.currentSessionInstanceId(),
      )

      // Forward to upstream
      const { statusCode, headers, body } = await lease.pool.upstreamClient.chatCompletions(
        lease.pool.token,
        upstreamBody,
      )

      // Success → stream response back
      if (statusCode >= 200 && statusCode < 300) {
        const responseHeaders = new Headers()
        for (const [key, value] of Object.entries(headers)) {
          if (key.toLowerCase() === 'content-length') continue
          if (value !== undefined) {
            if (Array.isArray(value)) {
              for (const v of value) responseHeaders.append(key, v)
            } else {
              responseHeaders.set(key, value)
            }
          }
        }

        runs.release(lease)
        console.log(`[${lease.pool.name}] request completed in ${Date.now() - startTime}ms (status: ${statusCode})`)

        // Stream the response body
        const webStream = Readable.toWeb(body) as ReadableStream<Uint8Array>
        return new Response(webStream, { status: statusCode, headers: responseHeaders })
      }

      // Error — read body for analysis
      const errorBody = await body.text()

      // Session invalid → invalidate + retry
      if (isSessionInvalid(statusCode, errorBody)) {
        console.log(`${lease.pool.name}: session invalid, refreshing and retrying`)
        lease.pool.invalidateSession(errorBody.trim())
        runs.release(lease)
        continue
      }

      // Run invalid → invalidate + retry
      if (isRunInvalid(statusCode, errorBody)) {
        console.log(`${lease.pool.name}: run ${lease.run.id} invalid, rotating and retrying`)
        runs.invalidate(lease, errorBody.trim())
        runs.release(lease)
        continue
      }

      // 401 → cooldown + invalidate session
      if (statusCode === 401) {
        runs.cooldown(lease, 30 * 60_000, 'upstream auth rejected token')
        lease.pool.invalidateSession('upstream auth rejected token')
      }

      runs.release(lease)
      console.log(`[${lease.pool.name}] upstream error: ${statusCode} ${errorBody.trim()}`)

      // Passthrough error
      const trimmed = errorBody.trim()
      if (trimmed && trimmed.startsWith('{')) {
        const { message, type, code } = extractUpstreamError(trimmed)
        return openAIError(statusCode, message, type, code)
      }
      return openAIError(statusCode, trimmed || 'upstream error', 'upstream_error')
    }

    return openAIError(502, 'upstream run expired twice in a row', 'server_error')
  }
}

// ─── Metadata Injection ────────────────────────────────────────

function injectUpstreamMetadata(
  payload: Record<string, unknown>,
  requestedModel: string,
  runId: string,
  sessionInstanceId: string,
): string {
  // Deep clone
  const cloned = JSON.parse(JSON.stringify(payload))
  cloned.model = requestedModel

  // Normalize tool schemas if present
  if (Array.isArray(cloned.tools)) {
    normalizeToolSchemas(cloned.tools)
  }

  // Inject codebuff_metadata
  let metadata = (cloned.codebuff_metadata ?? {}) as Record<string, unknown>
  metadata.run_id = runId
  metadata.cost_mode = 'free'
  metadata.client_id = generateClientSessionId()
  if (sessionInstanceId) {
    metadata.freebuff_instance_id = sessionInstanceId
  }
  cloned.codebuff_metadata = metadata

  return JSON.stringify(cloned)
}
