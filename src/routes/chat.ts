import type { AdsSpoof } from '../ads-spoof.js'
import type { Context } from 'hono'
import { Readable, Transform } from 'node:stream'
import type { Dispatcher } from 'undici'
import type { ModelPoolManager } from '../model-pool-manager.js'
import type { ModelRegistry } from '../model-registry.js'
import type { DB } from '../db.js'
import { normalizeToolSchemas } from '../schema-normalize.js'
import { BUFFY_SYSTEM_PROMPT } from '../system-prompt.js'
import { openAIError, isSessionInvalid, isRunInvalid, isQuotaError, isRateLimitError, isAccountBannedError, isCountryBlockedError, extractUpstreamError, generateClientSessionId, sanitizeBodyText, readDecompressedBody } from '../utils.js'
import { parseFreeModeRetryMs } from '../free-mode-gate.js'
import { resolveModelId } from '../types.js'

export function handleChatCompletions(
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
    const isStream = payload.stream === true


    const startTime = Date.now()
    console.log(`[chat] incoming: model=${requestedModel} agentId=${agentId}`)

    // Pools that already failed for this request — skipped on retry so we switch accounts.
    const failedPools = new Set<string>()

    // Last real upstream failure (status + body) — preferred for final log over proxy prose
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
        console.log(`[chat] acquire failed model=${requestedModel}: ${acquireReason}`)
        const latency = Date.now() - startTime
        const apiKeyId = apiKey ? getApiKeyId(apiKey) : null
        // Prefer last Freebuff body from a prior attempt; else raw acquire reason (may embed upstream text)
        const dbError = (lastUpstreamError ?? acquireReason).slice(0, 500)
        const dbStatus = lastUpstreamStatus ?? 503
        db.insertRequestLog({
          created_at: new Date(startTime).toISOString(),
          api_key: apiKey ?? null,
          api_key_id: apiKeyId,
          account_id: lastUpstreamAccount,
          model: requestedModel,
          agent_id: agentId,
          run_id: lastUpstreamRunId,
          status_code: dbStatus,
          tokens_in: null,
          tokens_out: null,
          latency_ms: latency,
          error: dbError,
          is_stream: isStream ? 1 : 0,
        })
        // Client: stable generic message. DB has the real error above.
        return openAIError(
          503,
          `all accounts for model "${requestedModel}" are unavailable`,
          'server_error',
        )
      }

      const instanceId = lease.pool.currentSessionInstanceId()
      console.log(`[${lease.pool.name}] routing request (poolModel: ${lease.pool.sessionModel}) via session: ${instanceId ?? 'none'}`)

      const upstreamBody = injectUpstreamMetadata(
        payload,
        requestedModel,
        lease.run.id,
        instanceId,
        lease.pool.sessionModel,
        lease.pool.traceSessionId,
      )

      let statusCode: number
      let headers: Record<string, string | string[] | undefined>
      let body: Dispatcher.ResponseData['body']
      try {
        const resp = await lease.pool.upstreamClient.chatCompletions(
          lease.pool.token,
          upstreamBody,
          lease.pool.proxyId || undefined,
          instanceId || undefined,
        )
        statusCode = resp.statusCode
        headers = resp.headers as Record<string, string | string[] | undefined>
        body = resp.body
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        console.log(`[${lease.pool.name}] upstream network error: ${err}`)
        // Log this attempt's real failure before retry
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
        // Session API: no run lifecycle to fail
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
        console.log(`[${lease.pool.name}] request completed in ${latency}ms (status: ${statusCode})`)

        const apiKeyId = apiKey ? getApiKeyId(apiKey) : null

        if (isStream) {
          const { transformedStream, tokensIn, tokensOut, donePromise } = interceptStreamForUsage(body)

          void donePromise.then(() => {
            const tIn = tokensIn()
            const tOut = tokensOut()
            // Session API: no run lifecycle to complete
            // Fire-and-forget cli_chat ad fetch with fake conversation
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
              tokens_in: tIn,
              tokens_out: tOut,
              latency_ms: Date.now() - startTime,
              error: null,
              is_stream: 1,
            })
          })

          const webStream = Readable.toWeb(transformedStream) as ReadableStream<Uint8Array>
          return new Response(webStream, { status: statusCode, headers: responseHeaders })
        } else {
          let bodyBuffer: ArrayBuffer
          try {
            bodyBuffer = await body.arrayBuffer()
          } catch (err) {
            console.log(`[${lease.pool.name}] error reading non-stream body: ${err}`)
            return openAIError(502, `upstream body read error: ${err}`, 'server_error')
          }
          let tokensIn: number | null = null
          let tokensOut: number | null = null
          let messageId: string | null = null
          try {
            const json = JSON.parse(Buffer.from(bodyBuffer).toString())
            if (json.usage) {
              tokensIn = json.usage.prompt_tokens ?? null
              tokensOut = json.usage.completion_tokens ?? null
            }
            if (json.id) messageId = json.id
          } catch { /* not JSON or no usage field */ }

          // Session API: no run lifecycle to complete

          // Fire-and-forget cli_chat ad fetch with fake conversation
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

          return new Response(bodyBuffer, { status: statusCode, headers: responseHeaders })
        }
      }

      // Non-2xx from Freebuff — always log the RAW body for this attempt
      const errorBody = sanitizeBodyText(await readDecompressedBody(body, headers))
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

      // Session API: no run lifecycle to fail
      // (failRun was here)

      if (isRateLimitError(statusCode, errorBody)) {
        // Free-mode rate limit: 6 sessions/hour per account.
        // Don't invalidate session — it's still valid, just usage-limited.
        // Cooldown for 10 min (not 30) so the account recovers faster.
        const retryMs = Math.min(parseFreeModeRetryMs(errorBody) ?? 10 * 60_000, 10 * 60_000)
        console.log(
          `${lease.pool.name}: free-mode rate limit — cooling ${Math.ceil(retryMs / 1000)}s (session kept alive), failing over`,
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
        // Short cooldown (30s) to avoid hammering a flaky backend on this account
        poolManager.cooldown(lease, 30_000, `upstream ${statusCode}`)
        failedPools.add(lease.pool.name)
        poolManager.release(lease)
        continue
      }

      poolManager.release(lease)
      console.log(`[${lease.pool.name}] upstream error: ${statusCode} ${errorBody.trim()}`)

      // Terminal (no more retry for this status) — return Freebuff status/body to client
      const trimmed = errorBody.trim()
      if (trimmed && trimmed.startsWith('{')) {
        const { message, type, code } = extractUpstreamError(trimmed)
        return openAIError(statusCode, message, type, code)
      }
      return openAIError(statusCode, trimmed || 'upstream error', 'upstream_error')
    }

    // Exhausted chat-level retries (quota/403/session/run paths all continued)
    const latency = Date.now() - startTime
    const apiKeyId = apiKey ? getApiKeyId(apiKey) : null
    const finalError = (lastUpstreamError ?? 'upstream run expired across all accounts').slice(0, 500)
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
      error: finalError,
      is_stream: isStream ? 1 : 0,
    })
    return openAIError(502, 'upstream run expired across all accounts', 'server_error')
  }
}
export function injectUpstreamMetadata(
  payload: Record<string, unknown>,
  requestedModel: string,
  runId: string,
  sessionInstanceId: string,
  poolModel: string,
  traceSessionId: string,
): string {
  const cloned = JSON.parse(JSON.stringify(payload))
  cloned.model = poolModel
  normalizeImageContentParts(cloned)
  normalizeReasoningEffort(cloned)


  // Inject the CLI "Buffy" system prompt so Codebuff API doesn't reject with "only allowed in cli"
  const messages = Array.isArray(cloned.messages)
    ? (cloned.messages as Array<Record<string, unknown>>)
    : []
  messages.unshift({ role: 'system', content: BUFFY_SYSTEM_PROMPT })
  cloned.messages = messages

  if (Array.isArray(cloned.tools)) {
    normalizeToolSchemas(cloned.tools)
  }

  let metadata = (cloned.codebuff_metadata ?? {}) as Record<string, unknown>
  metadata.run_id = runId
  metadata.cost_mode = 'free'
  metadata.client_id = generateClientSessionId()
  metadata.trace_session_id = traceSessionId
  if (sessionInstanceId) {
    metadata.freebuff_instance_id = sessionInstanceId
  }
  cloned.codebuff_metadata = metadata

  return JSON.stringify(cloned)
}

/**
 * Freebuff's Chat Completions API accepts `reasoning_effort`; its internal
 * Responses bridge derives `reasoning.effort` from that field. Forwarding both
 * representations makes the bridge reject a request when their values differ.
 */
function normalizeReasoningEffort(payload: Record<string, unknown>): void {
  const nestedReasoning = isRecord(payload.reasoning) ? payload.reasoning : undefined
  const nestedEffort = nestedReasoning?.effort
  const dottedEffort = payload['reasoning.effort']

  if (payload.reasoning_effort === undefined) {
    if (typeof nestedEffort === 'string') {
      payload.reasoning_effort = nestedEffort
    } else if (typeof dottedEffort === 'string') {
      payload.reasoning_effort = dottedEffort
    }
  }

  delete payload.reasoning
  delete payload['reasoning.effort']
}

function normalizeImageContentParts(payload: Record<string, unknown>): void {
  if (!Array.isArray(payload.messages)) return

  for (const message of payload.messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue
    message.content = message.content.map(normalizeContentPart)
  }
}

function normalizeContentPart(part: unknown): unknown {
  if (!isRecord(part)) return part

  if (part.type === 'image_url') {
    const url = extractImageUrl(part.image_url)
    return url ? { ...part, image_url: { url } } : part
  }

  if (part.type === 'input_image') {
    const url = extractImageUrl(part.image_url ?? part.image)
    return url ? { ...part, type: 'image_url', image_url: { url } } : part
  }

  if (part.type === 'image') {
    const url = extractImageUrl(part.image)
    if (!url) return part
    return {
      ...part,
      type: 'image_url',
      image_url: { url: toDataUrl(url, part.mediaType) },
    }
  }

  return part
}

function extractImageUrl(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (isRecord(value) && typeof value.url === 'string' && value.url.trim()) {
    return value.url.trim()
  }
  return null
}

function toDataUrl(value: string, mediaType: unknown): string {
  if (/^(data:|https?:)/i.test(value)) return value
  const mime = typeof mediaType === 'string' && mediaType.trim()
    ? mediaType.trim()
    : 'image/png'
  return `data:${mime};base64,${value}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

  const nodeStream = Readable.from(body as unknown as AsyncIterable<Uint8Array>)

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
