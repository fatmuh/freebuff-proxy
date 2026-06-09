import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'

export interface Account {
  id: string
  name: string
  email: string
  user_id: string
  token: string
  auth_token: string
  session_model: string
  proxy_id: string
  added_at: string
  paused: boolean
}

export interface ApiKeyEntry {
  id: string
  key: string
  name: string
  created_at: string
}

interface AuthData {
  accounts: Account[]
  api_keys: ApiKeyEntry[]
  next_id: number
  next_key_id: number
  keys_enabled: boolean
}

export class AuthStore {
  private accounts = new Map<string, Account>()
  private apiKeys = new Map<string, ApiKeyEntry>()
  private nextIdNum = 1
  private nextKeyIdNum = 1
  private _keysEnabled = true
  private filePath: string
  private log: (...args: unknown[]) => void

  constructor(dataDir: string, log: (...args: unknown[]) => void) {
    this.filePath = resolve(dataDir, 'auth.json')
    this.log = log
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf-8')
      const data: AuthData = JSON.parse(raw)
      this.nextIdNum = data.next_id ?? 1
      this.nextKeyIdNum = data.next_key_id ?? 1
      this._keysEnabled = data.keys_enabled ?? true
      if (data.accounts && Array.isArray(data.accounts)) {
        for (const acct of data.accounts) {
          if (acct.id && acct.token) {
            if (!acct.proxy_id) acct.proxy_id = ''
            this.accounts.set(acct.id, acct)
          }
        }
      }
      if (data.api_keys && Array.isArray(data.api_keys)) {
        for (const k of data.api_keys) {
          if (k.key) {
            // Migration: ensure existing keys have an id
            if (!k.id) {
              k.id = `key-${this.nextKeyIdNum++}`
            }
            this.apiKeys.set(k.key, k)
          }
        }
      }
      this.log('auth store: loaded', this.accounts.size, 'accounts,', this.apiKeys.size, 'api keys')
    } catch {
      this.log('auth store: no auth.json, starting fresh')
    }
  }

  // Account methods
  nextId(): number {
    const id = this.nextIdNum++
    this.persist()
    return id
  }

  addAccount(account: Account): void {
    this.accounts.set(account.id, account)
    this.persist()
    this.log('auth store: added account', account.id, account.email)
  }

  getAccount(id: string): Account | undefined {
    return this.accounts.get(id)
  }

  getAccountByEmail(email: string): Account | undefined {
    for (const acct of this.accounts.values()) {
      if (acct.email === email) return acct
    }
    return undefined
  }

  updateAccount(account: Account): void {
    this.accounts.set(account.id, account)
    this.persist()
  }

  removeAccount(id: string): boolean {
    const deleted = this.accounts.delete(id)
    if (deleted) {
      this.persist()
      this.log('auth store: removed account', id)
    }
    return deleted
  }

  listAccounts(): Omit<Account, 'token' | 'auth_token'>[] {
    return [...this.accounts.values()].map(a => ({
      id: a.id,
      name: a.name,
      email: a.email,
      user_id: a.user_id,
      session_model: a.session_model,
      proxy_id: a.proxy_id,
      added_at: a.added_at,
      paused: a.paused,
    }))
  }

  listAccountsFull(): Account[] {
    return [...this.accounts.values()]
  }

  getAccountTokens(): { id: string; token: string; session_model: string; proxy_id: string }[] {
    return [...this.accounts.values()]
      .filter(a => !a.paused)
      .map(a => ({ id: a.id, token: a.token, session_model: a.session_model, proxy_id: a.proxy_id }))
  }

  // API Key methods
  addApiKey(key: string, name: string): ApiKeyEntry {
    const id = `key-${this.nextKeyIdNum++}`
    const entry: ApiKeyEntry = {
      id,
      key,
      name,
      created_at: new Date().toISOString(),
    }
    this.apiKeys.set(key, entry)
    this.persist()
    this.log('auth store: added api key', name, 'id:', id)
    return entry
  }

  removeApiKey(key: string): boolean {
    const deleted = this.apiKeys.delete(key)
    if (deleted) this.persist()
    return deleted
  }

  getApiKey(key: string): ApiKeyEntry | undefined {
    return this.apiKeys.get(key)
  }

  updateApiKeyName(key: string, name: string): void {
    const entry = this.apiKeys.get(key)
    if (entry) {
      entry.name = name
      this.persist()
    }
  }

  listApiKeys(): (ApiKeyEntry & { masked_key: string })[] {
    return [...this.apiKeys.values()].map(k => ({
      ...k,
      masked_key: k.key.slice(0, 6) + '...' + k.key.slice(-4),
    }))
  }

  getAllApiKeyValues(): string[] {
    return [...this.apiKeys.keys()]
  }

  hasAnyApiKeys(): boolean {
    return this.apiKeys.size > 0
  }

  isKeysEnabled(): boolean {
    return this._keysEnabled
  }

  setKeysEnabled(enabled: boolean): void {
    this._keysEnabled = enabled
    this.persist()
    this.log('auth store: key protection', enabled ? 'enabled' : 'disabled')
  }

  getApiKeyId(apiKey: string): string | null {
    const entry = this.apiKeys.get(apiKey)
    return entry?.id ?? null
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      const data: AuthData = {
        accounts: [...this.accounts.values()],
        api_keys: [...this.apiKeys.values()],
        next_id: this.nextIdNum,
        next_key_id: this.nextKeyIdNum,
        keys_enabled: this._keysEnabled,
      }
      await writeFile(this.filePath, JSON.stringify(data, null, 2))
    } catch (err) {
      this.log('auth store: persist failed:', err)
    }
  }
}
