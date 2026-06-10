import type { Context } from 'hono'
import { Readable, Transform } from 'node:stream'
import type { Dispatcher } from 'undici'
import type { RunManager } from '../run-manager.js'
import type { ModelRegistry } from '../model-registry.js'
import type { DB } from '../db.js'
import { normalizeToolSchemas } from '../schema-normalize.js'
import { openAIError, isSessionInvalid, isRunInvalid, extractUpstreamError, generateClientSessionId } from '../utils.js'
import { PRIMARY_MODELS, DEFAULT_PRIMARY_MODEL, resolveModelId } from '../types.js'

export function handleChatCompletions(
  registry: ModelRegistry,
  runs: RunManager,
  db: DB,
  getApiKeyId: (apiKey: string) => string | null,
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

    const requestedModel = resolveModelId(String(payload.model ?? '').trim())
    if (!requestedModel) {
      return openAIError(400, 'model is required', 'invalid_request_error')
    }

    const agentId = registry.agentForModel(requestedModel)
    if (!agentId) {
      return openAIError(400, `unsupported model "${requestedModel}"`, 'invalid_request_error', 'model_not_found')
    }

    const apiKey = c.get('apiKey') as string | undefined
    const primaryModel = PRIMARY_MODELS.has(requestedModel) ? requestedModel : DEFAULT_PRIMARY_MODEL
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
        const apiKeyId = apiKey ? getApiKeyId(apiKey) : null
        db.insertRequestLog({
          created_at: new Date(startTime).toISOString(),
          api_key: apiKey ?? null,
          api_key_id: apiKeyId,
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

      let statusCode: number
      let headers: Record<string, string | string[] | undefined>
      let body: Dispatcher.ResponseData['body']
      try {
        const resp = await lease.pool.upstreamClient.chatCompletions(
          lease.pool.token,
          upstreamBody,
          lease.pool.proxyId || undefined,
        )
        statusCode = resp.statusCode
        headers = resp.headers as Record<string, string | string[] | undefined>
        body = resp.body
      } catch (err) {
        // Network error (socket closed, timeout, etc) — retry once like session/run invalid
        console.log(`[${lease.pool.name}] upstream network error: ${err}`)
        runs.release(lease)
        if (attempt === 0) continue
        return openAIError(502, `upstream network error: ${err}`, 'server_error')
      }

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

        lease.pool.signalSuccess()
        runs.release(lease)
        const latency = Date.now() - startTime
        console.log(`[${lease.pool.name}] request completed in ${latency}ms (status: ${statusCode})`)

        const apiKeyId = apiKey ? getApiKeyId(apiKey) : null

        if (isStream) {
          // Stream: intercept SSE chunks to extract usage from the chunk before [DONE]
          const { transformedStream, tokensIn, tokensOut, donePromise } = interceptStreamForUsage(body)

          // Insert log after stream ends (so we have token counts)
          void donePromise.then(() => {
            db.insertRequestLog({
              created_at: new Date(startTime).toISOString(),
              api_key: apiKey ?? null,
              api_key_id: apiKeyId,
              account_id: lease.pool.name,
              model: requestedModel,
              agent_id: agentId,
              run_id: lease.run.id,
              status_code: statusCode,
              tokens_in: tokensIn(),
              tokens_out: tokensOut(),
              latency_ms: Date.now() - startTime,
              error: null,
              is_stream: 1,
            })
          })

          const webStream = Readable.toWeb(transformedStream) as ReadableStream<Uint8Array>
          return new Response(webStream, { status: statusCode, headers: responseHeaders })
        } else {
          // Non-stream: buffer body, parse usage, then forward
          let bodyBuffer: ArrayBuffer
          try {
            bodyBuffer = await body.arrayBuffer()
          } catch (err) {
            console.log(`[${lease.pool.name}] error reading non-stream body: ${err}`)
            return openAIError(502, `upstream body read error: ${err}`, 'server_error')
          }
          let tokensIn: number | null = null
          let tokensOut: number | null = null
          try {
            const json = JSON.parse(Buffer.from(bodyBuffer).toString())
            if (json.usage) {
              tokensIn = json.usage.prompt_tokens ?? null
              tokensOut = json.usage.completion_tokens ?? null
            }
          } catch { /* not JSON or no usage field */ }

          db.insertRequestLog({
            created_at: new Date(startTime).toISOString(),
            api_key: apiKey ?? null,
            api_key_id: apiKeyId,
            account_id: lease.pool.name,
            model: requestedModel,
            agent_id: agentId,
            run_id: lease.run.id,
            status_code: statusCode,
            tokens_in: tokensIn,
            tokens_out: tokensOut,
            latency_ms: latency,
            error: null,
            is_stream: 0,
          })

          return new Response(bodyBuffer, { status: statusCode, headers: responseHeaders })
        }
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

      const apiKeyId = apiKey ? getApiKeyId(apiKey) : null
      db.insertRequestLog({
        created_at: new Date(startTime).toISOString(),
        api_key: apiKey ?? null,
        api_key_id: apiKeyId,
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
    const apiKeyId = apiKey ? getApiKeyId(apiKey) : null
    db.insertRequestLog({
      created_at: new Date(startTime).toISOString(),
      api_key: apiKey ?? null,
      api_key_id: apiKeyId,
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

function interceptStreamForUsage(body: unknown) {
  let tokensIn: number | null = null
  let tokensOut: number | null = null
  let buffer = ''
  let resolveDone: () => void
  const donePromise = new Promise<void>((resolve) => { resolveDone = resolve })

  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const text = chunk.toString('utf-8')
      buffer += text
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') continue
        try {
          const parsed = JSON.parse(data)
          if (parsed.usage) {
            tokensIn = parsed.usage.prompt_tokens ?? tokensIn
            tokensOut = parsed.usage.completion_tokens ?? tokensOut
          }
        } catch { /* not JSON, skip */ }
      }
      callback(null, chunk)
    },
    flush(callback) {
      if (buffer.startsWith('data: ')) {
        const data = buffer.slice(6).trim()
        if (data !== '[DONE]') {
          try {
            const parsed = JSON.parse(data)
            if (parsed.usage) {
              tokensIn = parsed.usage.prompt_tokens ?? tokensIn
              tokensOut = parsed.usage.completion_tokens ?? tokensOut
            }
          } catch { /* ignore */ }
        }
      }
      resolveDone()
      callback()
    },
  })

  // body from undici is an async iterable
  const nodeStream = Readable.from(body as unknown as AsyncIterable<Uint8Array>)

  // Prevent unhandled 'error' events (e.g. socket closed mid-stream) from crashing the process
  nodeStream.on('error', (err) => {
    console.log('[stream] upstream body error:', err)
    transform.destroy(err)
  })
  transform.on('error', (err) => {
    console.log('[stream] transform error:', err)
  })

  nodeStream.pipe(transform)

  return {
    transformedStream: transform,
    tokensIn: () => tokensIn,
    tokensOut: () => tokensOut,
    donePromise,
  }
}
