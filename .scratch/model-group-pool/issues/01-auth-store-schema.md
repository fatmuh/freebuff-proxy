## Parent

[PRD: Per-Model Account Pool Architecture](../PRD.md)

## What to build

freebuff-proxy's `Account` interface already has `session_model: string` (`~/proj/freebuff-proxy/src/auth-store.ts:11`). Add `serve_status` (`active` | `inactive`) and `account_status` (`idle` | `active` | `queued`) to every account record.

Build an in-memory `Map<model_id, Account[]>` index on startup from the existing `session_model` field on each account. Update the account listing API to return the new fields. Update the dashboard frontend to show two separate status columns per account (serve status + account status).

Note: freebuff-proxy does NOT have `active_account_id` (only free2api does at `~/proj/free2api/src/auth-store.ts:33` in `AuthData` interface, line 154 `getActiveAccountId()` method). The new architecture replaces the single-active-account concept with the model group index.

This is the foundation for the new per-model pool architecture. Without it, no downstream routing logic can function.

## Acceptance criteria

- [ ] Each account record has `serve_status` (default `active`) and `account_status` (default `idle`)
- [ ] On startup, a `Map<model, Account[]>` index is built from `session_model` bindings
- [ ] `/api/accounts` returns new fields in response
- [ ] Dashboard shows two status columns per account
- [ ] Adding/updating an account refreshes the model index immediately

## Blocked by

None - can start immediately

## Files to modify

- `~/proj/freebuff-proxy/src/auth-store.ts` (add new fields to Account, AuthData interfaces)
- `~/proj/freebuff-proxy/src/routes/accounts.ts` (return new fields in API)
- `~/proj/freebuff-proxy/src/run-manager.ts` (ensure TokenPool can read account_status from Account)

## Do NOT touch
- `~/proj/freebuff-proxy/src/types.ts` primary_model logic — will be removed later (Issue 03) but not in this issue
