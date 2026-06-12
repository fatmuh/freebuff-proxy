import type { Context } from 'hono'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import type { Dispatcher } from 'undici'
import type { ModelPoolManager } from '../model-pool-manager.js'
import type { ModelRegistry } from '../model-registry.js'
import type { DB } from '../db.js'
import { openAIError, isSessionInvalid, isRunInvalid, isQuotaError, extractUpstreamError, sanitizeBodyText, decompressBody, readDecompressedBody } from '../utils.js'
import { resolveModelId } from '../types.js'
import { convertResponsesToChat, buildResponseObject } from '../responses-converter.js'
import { createResponsesTransform } from '../responses-stream.js'
import type { ResponsesRequest } from '../responses-types.js'
import { injectUpstreamMetadata } from './chat.js'

/**
 * POST /v1/responses — OpenAI Responses API → Chat Completions bridge
 *
 * Converts the incoming Responses API request to Chat Completions format,
 * routes through the ModelPoolManager for per-model account selection,
 * then converts the upstream response back to Responses API format.
 */
export function handleResponses(
  registry: ModelRegistry,
  poolManager: ModelPoolManager,
  db: DB,
  getApiKeyId: (apiKey: string) => string | null,
) {
  return async (c: Context) => {
    if (c.req.method !== 'POST') {
      return openAIError(405, 'method not allowed', 'invalid_request_error')
    }

    let body: ResponsesRequest
    try {
      body = await c.req.json()
    } catch {
      return openAIError(400, 'request body must be valid JSON', 'invalid_request_error')
    }

    const requestedModel = resolveModelId(String(body.model ?? '').trim())
    if (!requestedModel) {
      return openAIError(400, 'model is required', 'invalid_request_error')
    }

    const agentId = registry.agentForModel(requestedModel)
    if (!agentId) {
      return openAIError(400, `unsupported model "${requestedModel}"`, 'invalid_request_error', 'model_not_found')
    }

    const apiKey = c.get('apiKey') as string | undefined
    const isStream = body.stream !== false

    const startTime = Date.now()
    console.log(`[responses] incoming: model=${requestedModel} agentId=${agentId}`)

    for (let attempt = 0; attempt < 2; attempt++) {
      const lease = await poolManager.acquire(requestedModel, agentId, requestedModel)
      if (!lease) {
        console.log(`[responses] no pools available for model=${requestedModel}`)
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
          status_code: 503,
          tokens_in: null,
          tokens_out: null,
          latency_ms: latency,
          error: `no healthy account for model ${requestedModel}`,
          is_stream: isStream ? 1 : 0,
        })
        return openAIError(503, `all accounts for model "${requestedModel}" are unavailable`, 'server_error')
      }

      console.log(`[${lease.pool.name}] routing responses request (poolModel: ${lease.pool.sessionModel}) via run: ${lease.run.id}`)

      // Convert Responses API → Chat Completions
      const chatPayload = convertResponsesToChat(body)

      // Inject upstream metadata (buffy prompt, image normalization, pool model override)
      const upstreamBody = injectUpstreamMetadata(
        chatPayload,
        requestedModel,
        lease.run.id,
        lease.pool.currentSessionInstanceId(),
        lease.pool.sessionModel,
      )

      let statusCode: number
      let headers: Record<string, string | string[] | undefined>
      let upstreamRespBody: Dispatcher.ResponseData['body']
      try {
        const resp = await lease.pool.upstreamClient.chatCompletions(
          lease.pool.token,
          upstreamBody,
          lease.pool.proxyId || undefined,
        )
        statusCode = resp.statusCode
        headers = resp.headers as Record<string, string | string[] | undefined>
        upstreamRespBody = resp.body
      } catch (err) {
        console.log(`[${lease.pool.name}] upstream network error: ${err}`)
        poolManager.release(lease)
        if (attempt === 0) continue
        return openAIError(502, `upstream network error: ${err}`, 'server_error')
      }

      if (statusCode >= 200 && statusCode < 300) {
        const responseHeaders = new Headers()
        for (const [key, value] of Object.entries(headers)) {
          const lower = key.toLowerCase()
          if (lower === 'content-length') continue
          if (lower === 'content-encoding') continue
          if (lower === 'transfer-encoding') continue
          if (lower === 'connection') continue
          if (lower === 'keep-alive') continue
          if (value !== undefined) {
            if (Array.isArray(value)) {
              for (const v of value) responseHeaders.append(key, v)
            } else {
              responseHeaders.set(key, value)
            }
          }
        }

        lease.pool.signalSuccess()
        poolManager.release(lease)
        const latency = Date.now() - startTime
        console.log(`[${lease.pool.name}] responses request completed in ${latency}ms (status: ${statusCode})`)

        const apiKeyId = apiKey ? getApiKeyId(apiKey) : null

        if (isStream) {
          // Streaming: transform upstream SSE → Responses API SSE
          const transform = createResponsesTransform(requestedModel, body.input)

          const nodeStream = Readable.from(upstreamRespBody as unknown as AsyncIterable<Uint8Array>)
          nodeStream.on('error', (err) => {
            console.log('[responses:stream] upstream body error:', err)
            transform.destroy(err)
          })
          transform.on('error', (err) => {
            console.log('[responses:stream] transform error:', err)
          })

          nodeStream.pipe(transform)

          // Log after stream completion
          const donePromise = new Promise<void>((resolve) => {
            transform.on('finish', () => {
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
                latency_ms: Date.now() - startTime,
                error: null,
                is_stream: 1,
              })
              resolve()
            })
          })
          void donePromise.catch(() => {})

          const webStream = Readable.toWeb(transform) as ReadableStream<Uint8Array>
          return new Response(webStream, { status: statusCode, headers: responseHeaders })
        } else {
          // Non-streaming: buffer → convert → return JSON
          let bodyBuffer: Buffer
          try {
            const raw = Buffer.from(await upstreamRespBody.arrayBuffer())
            const contentEncoding = typeof headers['content-encoding'] === 'string'
              ? headers['content-encoding']
              : Array.isArray(headers['content-encoding'])
                ? headers['content-encoding'][0]
                : undefined
            bodyBuffer = decompressBody(raw, contentEncoding)
          } catch (err) {
            console.log(`[${lease.pool.name}] error reading non-stream body: ${err}`)
            return openAIError(502, `upstream body read error: ${err}`, 'server_error')
          }

          let responsesBody: Record<string, unknown>
          try {
            const chatResponse = JSON.parse(bodyBuffer.toString('utf-8'))
            const responseId = `resp_${randomUUID().replace(/-/g, '')}`
            responsesBody = buildResponseObject(chatResponse, requestedModel, body.input, responseId) as unknown as Record<string, unknown>
          } catch (err) {
            console.log(`[${lease.pool.name}] error converting response: ${err}`)
            return openAIError(502, 'upstream response parse error', 'server_error')
          }

          const tokensIn = (responsesBody.usage as { input_tokens?: number })?.input_tokens ?? null
          const tokensOut = (responsesBody.usage as { output_tokens?: number })?.output_tokens ?? null

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

          return new Response(JSON.stringify(responsesBody), {
            status: statusCode,
            headers: { 'content-type': 'application/json' },
          })
        }
      }

      // Error handling
      const errorBody = sanitizeBodyText(await readDecompressedBody(upstreamRespBody, headers))
      const latency = Date.now() - startTime

      if (isQuotaError(statusCode, errorBody)) {
        console.log(`${lease.pool.name}: quota error from upstream, auto-pausing and retrying`)
        lease.pool.triggerQuotaPause()
        poolManager.release(lease)
        continue
      }

      if (statusCode === 403) {
        console.log(`${lease.pool.name}: upstream 403, failing over to next account`)
        poolManager.release(lease)
        if (attempt === 0) continue
      }

      if (isSessionInvalid(statusCode, errorBody)) {
        console.log(`${lease.pool.name}: session invalid, refreshing and retrying`)
        lease.pool.invalidateSession(errorBody.trim())
        poolManager.release(lease)
        continue
      }

      if (isRunInvalid(statusCode, errorBody)) {
        console.log(`${lease.pool.name}: run ${lease.run.id} invalid, rotating and retrying`)
        poolManager.invalidate(lease, errorBody.trim())
        poolManager.release(lease)
        continue
      }

      if (statusCode === 401) {
        poolManager.cooldown(lease, 30 * 60_000, 'upstream auth rejected token')
        lease.pool.invalidateSession('upstream auth rejected token')
      }

      poolManager.release(lease)
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
