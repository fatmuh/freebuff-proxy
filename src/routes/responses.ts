import type { AdsSpoof } from '../ads-spoof.js'
import type { Context } from 'hono'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import type { Dispatcher } from 'undici'
import type { ModelPoolManager } from '../model-pool-manager.js'
import type { ModelRegistry } from '../model-registry.js'
import type { DB } from '../db.js'
import { openAIError, isSessionInvalid, isRunInvalid, isQuotaError, isRateLimitError, isAccountBannedError, isCountryBlockedError, extractUpstreamError, sanitizeBodyText, decompressBody, readDecompressedBody } from '../utils.js'
import { parseFreeModeRetryMs } from '../free-mode-gate.js'
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
  adsSpoof: AdsSpoof,
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

    // Pools that already failed for this request — skipped on retry so we switch accounts.
    const failedPools = new Set<string>()
    let lastUpstreamStatus: number | null = null
    let lastUpstreamError: string | null = null
    let lastUpstreamAccount: string | null = null
    let lastUpstreamRunId: string | null = null


    for (let attempt = 0; attempt < 3; attempt++) {
      const { lease, reason: acquireReason } = await poolManager.acquire(
        requestedModel,
        agentId,
        requestedModel,
        attempt === 0 ? undefined : failedPools,
      )
      if (!lease) {
        console.log(`[responses] acquire failed model=${requestedModel}: ${acquireReason}`)
        const latency = Date.now() - startTime
        const apiKeyId = apiKey ? getApiKeyId(apiKey) : null
        const dbError = (lastUpstreamError ?? acquireReason).slice(0, 500)
        db.insertRequestLog({
          created_at: new Date(startTime).toISOString(),
          api_key: apiKey ?? null,
          api_key_id: apiKeyId,
          account_id: lastUpstreamAccount,
          model: requestedModel,
          agent_id: agentId,
          run_id: lastUpstreamRunId,
          status_code: lastUpstreamStatus ?? 503,
          tokens_in: null,
          tokens_out: null,
          latency_ms: latency,
          error: dbError,
          is_stream: isStream ? 1 : 0,
        })
        return openAIError(
          503,
          `all accounts for model "${requestedModel}" are unavailable`,
          'server_error',
        )
      }

      const instanceId = lease.pool.currentSessionInstanceId()
      console.log(`[${lease.pool.name}] routing responses request (poolModel: ${lease.pool.sessionModel}) via session: ${instanceId ?? 'none'}`)

      // Convert Responses API → Chat Completions
      const chatPayload = convertResponsesToChat(body)

      // Inject upstream metadata (buffy prompt, image normalization, pool model override)
      const upstreamBody = injectUpstreamMetadata(
        chatPayload,
        requestedModel,
        lease.run.id,
        instanceId,
        lease.pool.sessionModel,
        lease.pool.traceSessionId,
      )

      let statusCode: number
      let headers: Record<string, string | string[] | undefined>
      let upstreamRespBody: Dispatcher.ResponseData['body']
      try {
        const resp = await lease.pool.upstreamClient.chatCompletions(
          lease.pool.token,
          upstreamBody,
          lease.pool.proxyId || undefined,
          instanceId || undefined,
        )
        statusCode = resp.statusCode
        headers = resp.headers as Record<string, string | string[] | undefined>
        upstreamRespBody = resp.body
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        console.log(`[${lease.pool.name}] upstream network error: ${err}`)
        const apiKeyId = apiKey ? getApiKeyId(apiKey) : null
        db.insertRequestLog({
          created_at: new Date(startTime).toISOString(),
          api_key: apiKey ?? null,
          api_key_id: apiKeyId,
          account_id: lease.pool.name,
          model: requestedModel,
          agent_id: agentId,
          run_id: lease.run.id,
          status_code: 502,
          tokens_in: null,
          tokens_out: null,
          latency_ms: Date.now() - startTime,
          error: `upstream network error: ${detail}`.slice(0, 500),
          is_stream: isStream ? 1 : 0,
        })
        lastUpstreamStatus = 502
        lastUpstreamError = `upstream network error: ${detail}`
        lastUpstreamAccount = lease.pool.name
        lastUpstreamRunId = lease.run.id
        failedPools.add(lease.pool.name)
        poolManager.release(lease)
        if (attempt < 2) continue
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
              // Session API: no run lifecycle to complete
              adsSpoof?.maybeFireChat(lease.pool.name, lease.pool.token, lease.pool.proxyId || undefined)
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
          let tokensIn: number | null = null
          let tokensOut: number | null = null
          let messageId: string | null = null
          const usage = responsesBody.usage
          if (usage && typeof usage === 'object') {
            if ('input_tokens' in usage && typeof usage.input_tokens === 'number') tokensIn = usage.input_tokens
            if ('output_tokens' in usage && typeof usage.output_tokens === 'number') tokensOut = usage.output_tokens
          }
          if (responsesBody.id && typeof responsesBody.id === 'string') messageId = responsesBody.id

          // Session API: no run lifecycle to complete
          // Fire-and-forget cli_chat ad fetch
          adsSpoof?.maybeFireChat(lease.pool.name, lease.pool.token, lease.pool.proxyId || undefined)

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

      // Error handling — log RAW Freebuff body for THIS attempt before any continue
      const errorBody = sanitizeBodyText(await readDecompressedBody(upstreamRespBody, headers))
      const latency = Date.now() - startTime
      const rawError = errorBody.trim().slice(0, 500)
      const apiKeyId = apiKey ? getApiKeyId(apiKey) : null

      lastUpstreamStatus = statusCode
      lastUpstreamError = rawError || `upstream HTTP ${statusCode}`
      lastUpstreamAccount = lease.pool.name
      lastUpstreamRunId = lease.run.id

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
        error: lastUpstreamError,
        is_stream: isStream ? 1 : 0,
      })

      if (isRateLimitError(statusCode, errorBody)) {
        const retryMs = parseFreeModeRetryMs(errorBody) ?? 30 * 60_000
        console.log(
          `${lease.pool.name}: free-mode rate limit — cooling account for ${Math.ceil(retryMs / 1000)}s and failing over`,
        )
        poolManager.cooldown(lease, retryMs, errorBody.trim() || 'free-mode rate limited')
        failedPools.add(lease.pool.name)
        poolManager.release(lease)
        continue
      }

      if (isQuotaError(statusCode, errorBody)) {
        console.log(`${lease.pool.name}: quota error from upstream, auto-pausing and retrying`)
        lease.pool.triggerQuotaPause()
        failedPools.add(lease.pool.name)
        poolManager.release(lease)
        continue
      }
      if (isAccountBannedError(statusCode, errorBody)) {
        console.log(`${lease.pool.name}: account banned — marking inactive`)
        lease.pool.markBanned('banned')
        failedPools.add(lease.pool.name)
        poolManager.release(lease)
        continue
      }
      if (isCountryBlockedError(statusCode, errorBody)) {
        console.log(`${lease.pool.name}: country_blocked — fail over (no permanent ban)`)
        lease.pool.lastError = 'country_blocked'
        failedPools.add(lease.pool.name)
        poolManager.release(lease)
        continue
      }
      if (statusCode === 403) {
        console.log(`${lease.pool.name}: upstream 403, failing over to next account`)
        failedPools.add(lease.pool.name)
        poolManager.release(lease)
        continue
      }

      if (isSessionInvalid(statusCode, errorBody)) {
        console.log(`${lease.pool.name}: session invalid — ending session and rebuilding fresh`)
        lease.pool.invalidateSession(errorBody.trim())
        await lease.pool.endSessionNow().catch((err: unknown) => console.log(`${lease.pool.name}: endSession error: ${err}`))
        failedPools.add(lease.pool.name)
        poolManager.release(lease)
        continue
      }

      if (isRunInvalid(statusCode, errorBody)) {
        console.log(`${lease.pool.name}: run ${lease.run.id} invalid, rotating and retrying`)
        poolManager.invalidate(lease, errorBody.trim())
        failedPools.add(lease.pool.name)
        poolManager.release(lease)
        continue
      }

      if (statusCode === 401) {
        poolManager.cooldown(lease, 30 * 60_000, 'upstream auth rejected token')
        lease.pool.invalidateSession('upstream auth rejected token')
        failedPools.add(lease.pool.name)
        poolManager.release(lease)
        continue
      }

      // Generic 5xx (502/503/504) — failover to next account instead of returning error to client
      if (statusCode >= 500) {
        console.log(`[${lease.pool.name}] upstream ${statusCode}, failing over to next account`)
        poolManager.cooldown(lease, 30_000, `upstream ${statusCode}`)
        failedPools.add(lease.pool.name)
        poolManager.release(lease)
        continue
      }

      poolManager.release(lease)
      console.log(`[${lease.pool.name}] upstream error: ${statusCode} ${errorBody.trim()}`)

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
      account_id: lastUpstreamAccount,
      model: requestedModel,
      agent_id: agentId,
      run_id: lastUpstreamRunId,
      status_code: lastUpstreamStatus ?? 502,
      tokens_in: null,
      tokens_out: null,
      latency_ms: latency,
      error: (lastUpstreamError ?? 'upstream run expired across all accounts').slice(0, 500),
      is_stream: isStream ? 1 : 0,
    })
    return openAIError(502, 'upstream run expired across all accounts', 'server_error')
  }
}
