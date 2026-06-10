## Parent

[PRD: Per-Model Account Pool Architecture](../PRD.md)

## What to build

Port chat request transformation features from free2api (`~/proj/free2api/src/routes/chat.ts`):

1. **Buffy system prompt injection** (chat.ts:286-290)
   - Copy `BUFFY_SYSTEM_PROMPT` import and message unshift logic
   - freebuff-proxy currently has no system prompt injection

2. **Image content normalization** (chat.ts:308-357)
   - Copy `normalizeImageContentParts()`, `normalizeContentPart()`, `extractImageUrl()`, `toDataUrl()`, `isRecord()`
   - Converts `input_image` → `image_url`, base64 data URLs → proper format
   - freebuff-proxy currently has no image normalization

3. **Pool model override** (chat.ts:273-306)
   - In free2api, `injectUpstreamMetadata()` takes `poolModel` param and sets `cloned.model = poolModel` (chat.ts:282)
   - In freebuff-proxy, same function sets `cloned.model = requestedModel` (chat.ts:262)
   - Override: use session's bound model instead of user's requested model in upstream payload

4. **BUN_USER_AGENT** (utils.ts:19)
   - Copy constant, use on upstream requests

Wire chat completions route to use `ModelPoolManager` for account selection instead of old global `RunManager.getActivePool()`.

After successful upstream response (2xx), **signal back to pool to reset idle timer**. Failed responses do NOT.

## Acceptance criteria

- [ ] Buffy system prompt injected as first system message — port from `~/proj/free2api/src/routes/chat.ts:286-290`
- [ ] Image `input_image` normalized to `image_url` — port from `~/proj/free2api/src/routes/chat.ts:308-357`
- [ ] Base64 image data gets data URL wrapper
- [ ] Upstream payload uses pool's bound model, not request model — port from `~/proj/free2api/src/routes/chat.ts:282`, change from `~/proj/freebuff-proxy/src/routes/chat.ts:262`
- [ ] Chat route wires into `ModelPoolManager` instead of `RunManager.getActivePool()`
- [ ] Successful responses reset idle timer; failed ones do not

## Blocked by

- [03-model-pool-manager](../issues/03-model-pool-manager.md) — needs selection logic

## Files to modify

- `~/proj/freebuff-proxy/src/routes/chat.ts` — merge transformation logic from free2api
- `~/proj/freebuff-proxy/src/utils.ts` — add `BUN_USER_AGENT` constant
- `~/proj/freebuff-proxy/src/system-prompt.ts` — **CREATE** (copy from `~/proj/free2api/src/system-prompt.ts`)

## Source references
- `~/proj/free2api/src/routes/chat.ts:286-290` (buffy prompt)
- `~/proj/free2api/src/routes/chat.ts:308-357` (image normalization)
- `~/proj/free2api/src/routes/chat.ts:273-306` (injectUpstreamMetadata)
- `~/proj/free2api/src/utils.ts:19` (BUN_USER_AGENT)
- `~/proj/free2api/src/system-prompt.ts` (prompt constant)

## Do NOT port from free2api
- `~/proj/free2api/src/routes/chat.ts:44-50` — `getActiveSessionModel()` check. Not needed with model pool manager.
