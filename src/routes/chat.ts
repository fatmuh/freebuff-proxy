import type { Context } from 'hono'
import { Readable } from 'node:stream'
import type { Dispatcher } from 'undici'
import type { RunManager } from '../run-manager.js'
import type { ModelRegistry } from '../model-registry.js'
import type { BindingStore } from '../binding-store.js'
import type { DB } from '../db.js'
import { normalizeToolSchemas } from '../schema-normalize.js'
import { openAIError, isSessionInvalid, isRunInvalid, extractUpstreamError, generateClientSessionId } from '../utils.js'

export function handleChatCompletions(
  registry: ModelRegistry,
  runs: RunManager,
  bindings: BindingStore,
  db: DB,
) {
  return async (c: Context) => {
    if (c.req.method !== 'POST') {
      return openAIError(405, 'method not allowed', 'invalid_request_error')
    }

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

    const agentId = registry.agentForModel(requestedModel)
    if (!agentId) {
      return openAIError(400, `unsupported model "${requestedModel}"`, 'invalid_request_error', 'model_not_found')
    }

    const apiKey = c.get('apiKey') as string | undefined
    const primaryModel = apiKey ? bindings.get(apiKey) : 'minimax/minimax-m2.7'
    const isStream = payload.stream === true

    const startTime = Date.now()
    console.log(`[chat] incoming: model=${requestedModel} agentId=${agentId} primary=${primaryModel}`)

    for (let attempt = 0; attempt < 2; attempt++) {
      let lease
      try {
        lease = await runs.acquire(primaryModel, agentId, requestedModel)
      } catch (err) {
        console.log(`[chat] acquire failed: attempt=${attempt} err=${err}`)
        const latency = Date.now() - startTime
        db.insertRequestLog({
          created_at: new Date(startTime).toISOString(),
          api_key: apiKey ?? null,
          account_id: null,
          model: requestedModel,
          agent_id: agentId,
          run_id: null,
          status_code: 502,
          tokens_in: null,
          tokens_out: null,
          latency_ms: latency,
          error: String(err),
          is_stream: isStream ? 1 : 0,
        })
        return openAIError(502, 'no healthy upstream auth token available', 'server_error')
      }

      console.log(`[${lease.pool.name}] routing request (model: ${requestedModel}) via run: ${lease.run.id}`)

      const upstreamBody = injectUpstreamMetadata(
        payload,
        requestedModel,
        lease.run.id,
        lease.pool.currentSessionInstanceId(),
      )

      const { statusCode, headers, body } = await lease.pool.upstreamClient.chatCompletions(
        lease.pool.token,
        upstreamBody,
      )

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
        const latency = Date.now() - startTime
        console.log(`[${lease.pool.name}] request completed in ${latency}ms (status: ${statusCode})`)

        db.insertRequestLog({
          created_at: new Date(startTime).toISOString(),
          api_key: apiKey ?? null,
          account_id: lease.pool.name,
          model: requestedModel,
          agent_id: agentId,
          run_id: lease.run.id,
          status_code: statusCode,
          tokens_in: null,
          tokens_out: null,
          latency_ms: latency,
          error: null,
          is_stream: isStream ? 1 : 0,
        })

        const webStream = Readable.toWeb(body) as ReadableStream<Uint8Array>
        return new Response(webStream, { status: statusCode, headers: responseHeaders })
      }

      const errorBody = await body.text()
      const latency = Date.now() - startTime

      if (isSessionInvalid(statusCode, errorBody)) {
        console.log(`${lease.pool.name}: session invalid, refreshing and retrying`)
        lease.pool.invalidateSession(errorBody.trim())
        runs.release(lease)
        continue
      }

      if (isRunInvalid(statusCode, errorBody)) {
        console.log(`${lease.pool.name}: run ${lease.run.id} invalid, rotating and retrying`)
        runs.invalidate(lease, errorBody.trim())
        runs.release(lease)
        continue
      }

      if (statusCode === 401) {
        runs.cooldown(lease, 30 * 60_000, 'upstream auth rejected token')
        lease.pool.invalidateSession('upstream auth rejected token')
      }

      runs.release(lease)
      console.log(`[${lease.pool.name}] upstream error: ${statusCode} ${errorBody.trim()}`)

      db.insertRequestLog({
        created_at: new Date(startTime).toISOString(),
        api_key: apiKey ?? null,
        account_id: lease.pool.name,
        model: requestedModel,
        agent_id: agentId,
        run_id: lease.run.id,
        status_code: statusCode,
        tokens_in: null,
        tokens_out: null,
        latency_ms: latency,
        error: errorBody.trim().slice(0, 500),
        is_stream: isStream ? 1 : 0,
      })

      const trimmed = errorBody.trim()
      if (trimmed && trimmed.startsWith('{')) {
        const { message, type, code } = extractUpstreamError(trimmed)
        return openAIError(statusCode, message, type, code)
      }
      return openAIError(statusCode, trimmed || 'upstream error', 'upstream_error')
    }

    const latency = Date.now() - startTime
    db.insertRequestLog({
      created_at: new Date(startTime).toISOString(),
      api_key: apiKey ?? null,
      account_id: null,
      model: requestedModel,
      agent_id: agentId,
      run_id: null,
      status_code: 502,
      tokens_in: null,
      tokens_out: null,
      latency_ms: latency,
      error: 'upstream run expired twice in a row',
      is_stream: isStream ? 1 : 0,
    })
    return openAIError(502, 'upstream run expired twice in a row', 'server_error')
  }
}

function injectUpstreamMetadata(
  payload: Record<string, unknown>,
  requestedModel: string,
  runId: string,
  sessionInstanceId: string,
): string {
  const cloned = JSON.parse(JSON.stringify(payload))
  cloned.model = requestedModel

  if (Array.isArray(cloned.tools)) {
    normalizeToolSchemas(cloned.tools)
  }

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
