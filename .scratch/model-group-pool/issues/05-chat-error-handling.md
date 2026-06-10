## Parent

[PRD: Per-Model Account Pool Architecture](../PRD.md)

## What to build

Port decompressed error body handling from free2api (`~/proj/free2api/src/utils.ts`):

1. **`decompressBody()`** (utils.ts:151-163)
   - Handles `gzip`, `deflate`, `br` on upstream error responses
   - freebuff-proxy currently just does `body.text()` with no decompression

2. **`readDecompressedBody()`** (utils.ts:169-182)
   - Reads undici body + headers, decompresses if needed
   - Uses `decompressBody()` internally

3. **`sanitizeBodyText()`** (utils.ts:192-211)
   - Detects binary/garbled bodies (>15% high-byte chars or replacement char)
   - Replaces with clean message: `(binary body, N bytes — content-encoding mismatch)`

4. **`extractUpstreamError()`** (utils.ts:109-128)
   - freebuff-proxy already has similar function but does NOT handle decompression
   - Keep freebuff-proxy's version but add decompression step before calling it

Update chat route to use these utilities on all non-2xx responses. Return 503 with the model name when all accounts in the model group are unavailable.

## Acceptance criteria

- [ ] `decompressBody()` ported from `~/proj/free2api/src/utils.ts:151-163`
- [ ] `readDecompressedBody()` ported from `~/proj/free2api/src/utils.ts:169-182`
- [ ] `sanitizeBodyText()` ported from `~/proj/free2api/src/utils.ts:192-211`
- [ ] Upstream error bodies decompressed before parsing in chat route
- [ ] Garbled binary bodies sanitized to clean message
- [ ] Proper OpenAI-style error JSON returned to client
- [ ] When all accounts unavailable: 503 with model name in message

## Blocked by

- [03-model-pool-manager](../issues/03-model-pool-manager.md) — needs "all unavailable" detection

## Files to modify

- `~/proj/freebuff-proxy/src/utils.ts` — add decompressBody, readDecompressedBody, sanitizeBodyText
- `~/proj/freebuff-proxy/src/routes/chat.ts` — use on non-2xx responses

## Source references
- `~/proj/free2api/src/utils.ts:151-163` (decompressBody)
- `~/proj/free2api/src/utils.ts:169-182` (readDecompressedBody)
- `~/proj/free2api/src/utils.ts:192-211` (sanitizeBodyText)
- `~/proj/freebuff-proxy/src/routes/chat.ts:184` (current error body reading: `body.text()`)

## Do NOT port from free2api
- `~/proj/free2api/src/routes/chat.ts:193` — `sanitizeBodyText(await readDecompressedBody(...))` line. Use equivalent logic but adapted to freebuff-proxy's error flow.
