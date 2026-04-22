import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import type { Binding, BindingStoreData } from './types.js'
import { DEFAULT_PRIMARY_MODEL } from './types.js'

// ─── Binding Store ──────────────────────────────────────────────
// Maps API keys to primary models (minimax/glm).
// Persisted to data/bindings.json, loaded on startup.

const DEFAULT_DATA_DIR = 'data'
const BINDINGS_FILE = 'bindings.json'

export class BindingStore {
  private bindings = new Map<string, Binding>()
  private filePath: string
  private log: (...args: unknown[]) => void

  constructor(dataDir: string, log: (...args: unknown[]) => void) {
    this.filePath = resolve(dataDir, BINDINGS_FILE)
    this.log = log
  }

  // ─── Lifecycle ───────────────────────────────────────────────

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf-8')
      const data: BindingStoreData = JSON.parse(raw)
      if (data.bindings && Array.isArray(data.bindings)) {
        for (const b of data.bindings) {
          if (b.apiKey && b.model) {
            this.bindings.set(b.apiKey, b)
          }
        }
      }
      this.log('binding store: loaded', this.bindings.size, 'bindings from', this.filePath)
    } catch {
      this.log('binding store: no existing file, starting fresh')
    }
  }

  // ─── Public API ──────────────────────────────────────────────

  /** Bind an API key to a primary model. Returns true if created/updated. */
  bind(apiKey: string, model: string): boolean {
    const existing = this.bindings.get(apiKey)
    if (existing && existing.model === model) return false // no change

    this.bindings.set(apiKey, {
      apiKey,
      model,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    })
    this.persist()
    this.log('binding store: bound', apiKey.slice(0, 8) + '...', '→', model)
    return true
  }

  /** Remove a binding. Returns true if it existed. */
  unbind(apiKey: string): boolean {
    const deleted = this.bindings.delete(apiKey)
    if (deleted) {
      this.persist()
      this.log('binding store: unbound', apiKey.slice(0, 8) + '...')
    }
    return deleted
  }

  /** Get the primary model for an API key, or the default. */
  get(apiKey: string): string {
    return this.bindings.get(apiKey)?.model ?? DEFAULT_PRIMARY_MODEL
  }

  /** Check if a key has an explicit binding */
  has(apiKey: string): boolean {
    return this.bindings.has(apiKey)
  }

  /** List all bindings */
  list(): Binding[] {
    return [...this.bindings.values()]
  }

  // ─── Persistence ────────────────────────────────────────────

  private async persist(): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      const data: BindingStoreData = {
        bindings: [...this.bindings.values()],
      }
      await writeFile(this.filePath, JSON.stringify(data, null, 2))
    } catch (err) {
      this.log('binding store: persist failed:', err)
    }
  }
}
