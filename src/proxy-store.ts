import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'

// Proxy types supported by the system
export type ProxyType = 'http' | 'socks5' | 'relay'

export interface ProxyEntry {
  id: string
  name: string
  type: ProxyType
  host: string
  port: number
  username: string
  password: string
  created_at: string
}

interface ProxyStoreData {
  proxies: ProxyEntry[]
  next_id: number
}

// Build a proxy URL from a ProxyEntry (e.g. "http://user:pass@host:port" or "socks5://user:pass@host:port")
export function proxyUrl(entry: ProxyEntry): string {
  const scheme = entry.type === 'socks5' ? 'socks5' : 'http'
  const auth = entry.username
    ? `${encodeURIComponent(entry.username)}:${encodeURIComponent(entry.password)}@`
    : ''
  return `${scheme}://${auth}${entry.host}:${entry.port}`
}

// Strip credentials for safe display
export function proxyUrlSafe(entry: ProxyEntry): string {
  if (entry.type === 'relay') return entry.host
  const scheme = entry.type === 'socks5' ? 'socks5' : 'http'
  return `${scheme}://${entry.host}:${entry.port}`
}

export class ProxyStore {
  private proxies = new Map<string, ProxyEntry>()
  private nextIdNum = 1
  private filePath: string
  private log: (...args: unknown[]) => void

  constructor(dataDir: string, log: (...args: unknown[]) => void) {
    this.filePath = resolve(dataDir, 'proxies.json')
    this.log = log
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf-8')
      const data: ProxyStoreData = JSON.parse(raw)
      this.nextIdNum = data.next_id ?? 1
      if (data.proxies && Array.isArray(data.proxies)) {
        for (const p of data.proxies) {
          if (p.id && p.host && p.port) {
            this.proxies.set(p.id, p)
          }
        }
      }
      this.log('proxy store: loaded', this.proxies.size, 'proxies')
    } catch {
      this.log('proxy store: no proxies.json, starting fresh')
    }
  }

  nextId(): number {
    const id = this.nextIdNum++
    this.persist()
    return id
  }

  addProxy(proxy: ProxyEntry): void {
    this.proxies.set(proxy.id, proxy)
    this.persist()
    this.log('proxy store: added proxy', proxy.id, proxy.name, `(${proxy.type}://${proxy.host}:${proxy.port})`)
  }

  getProxy(id: string): ProxyEntry | undefined {
    return this.proxies.get(id)
  }

  updateProxy(proxy: ProxyEntry): void {
    this.proxies.set(proxy.id, proxy)
    this.persist()
    this.log('proxy store: updated proxy', proxy.id)
  }

  removeProxy(id: string): boolean {
    const deleted = this.proxies.delete(id)
    if (deleted) {
      this.persist()
      this.log('proxy store: removed proxy', id)
    }
    return deleted
  }

  listProxies(): ProxyEntry[] {
    return [...this.proxies.values()]
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      const data: ProxyStoreData = {
        proxies: [...this.proxies.values()],
        next_id: this.nextIdNum,
      }
      await writeFile(this.filePath, JSON.stringify(data, null, 2))
    } catch (err) {
      this.log('proxy store: persist failed:', err)
    }
  }
}
