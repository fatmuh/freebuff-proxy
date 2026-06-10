## Parent

[PRD: Per-Model Account Pool Architecture](../PRD.md)

## What to build

Port the OpenAI Responses API endpoint from free2api. Create 4 files in freebuff-proxy by copying from free2api:

### Files to CREATE (copy from free2api, adapt routing):

| Source (`~/proj/free2api/src/`) | Destination (`~/proj/freebuff-proxy/src/`) | Adaptations |
|----------------------------------|------------------------------------------|-------------|
| `responses-types.ts` | `responses-types.ts` | Copy verbatim — type definitions |
| `responses-converter.ts` | `responses-converter.ts` | Copy verbatim — conversion logic |
| `responses-stream.ts` | `responses-stream.ts` | Copy verbatim — stream transformer |
| `routes/responses.ts` | `routes/responses.ts` | **Adapt routing logic** |

### Adaptations for `routes/responses.ts`:
- `responses.ts` imports `injectUpstreamMetadata` from `chat.ts` (free2api: responses.ts:13)
- In free2api, `injectUpstreamMetadata` calls from `chat.ts` trigger buffy prompt injection + image normalization automatically
- Must use `ModelPoolManager` for account selection instead of `RunManager.acquire()`
- Apply model override (`poolModel`) instead of requested model
- Same retry/failover logic as chat: 3 retries per account, failover to next in model group

### Route wiring:
- Add `POST /v1/responses` in `~/proj/freebuff-proxy/src/server.ts`
- Reuse the model pool selection logic from Issue 03

## Acceptance criteria

- [ ] `POST /v1/responses` endpoint exists and accepts standard OpenAI Responses API format
- [ ] Converts incoming request to chat completions internally
- [ ] Routes through `ModelPoolManager` using same selection logic as chat
- [ ] Applies buffy prompt, image normalization, model override (via shared `injectUpstreamMetadata`)
- [ ] Streaming path: transforms upstream SSE into Responses API SSE events
- [ ] Non-streaming path: builds full ResponseObject from upstream chat response
- [ ] Returns proper error format on failure

## Blocked by

- [03-model-pool-manager](../issues/03-model-pool-manager.md) — needs routing
- [04-chat-transformation](../issues/04-chat-transformation.md) — needs `injectUpstreamMetadata` callable from responses.ts

## Files to create

- `~/proj/freebuff-proxy/src/routes/responses.ts` (adapt from `~/proj/free2api/src/routes/responses.ts`)
- `~/proj/freebuff-proxy/src/responses-types.ts` (copy from `~/proj/free2api/src/responses-types.ts`)
- `~/proj/freebuff-proxy/src/responses-converter.ts` (copy from `~/proj/free2api/src/responses-converter.ts`)
- `~/proj/freebuff-proxy/src/responses-stream.ts` (copy from `~/proj/free2api/src/responses-stream.ts`)

## Files to modify

- `~/proj/freebuff-proxy/src/server.ts` — register `/v1/responses` endpoint

## Source references
- `~/proj/free2api/src/routes/responses.ts:13` (injectUpstreamMetadata import)
- `~/proj/free2api/src/routes/responses.ts:16-319` (full handler)
- `~/proj/free2api/src/routes/chat.ts:273-306` (injectUpstreamMetadata function)

## Do NOT port from free2api
- `~/proj/free2api/src/routes/responses.ts:49` — `getActiveSessionModel()` check. Not needed with model pool manager.
