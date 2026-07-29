// ─── Synthetic Device Fingerprint ──────────────────────────────
// Generates stable, privacy-preserving fingerprints that match the
// real Freebuff CLI's enhanced fingerprint SHAPE without exposing
// any real hardware identifiers.
//
// Each account gets a deterministic device profile seeded from its
// account id. The profile includes realistic system/cpu/os data
// sourced from common real devices, plus synthetic MAC addresses
// using real vendor OUI prefixes with locally-administered suffixes.

import { createHash, randomBytes } from 'node:crypto'

// ─── Real OUI Prefixes (from IEEE registry) ────────────────────

const APPLE_OUIS = [
  '00:1D:4F', '00:1E:52', '00:1EC2', '00:1F:5B', '00:1FF3',
  '00:21:E9', '00:22:41', '00:23:12', '00:23:32', '00:23:6C',
  '00:23:DF', '00:24:36', '3C:22:35', '8C:85:90', 'A4:5E:60',
  'F0:18:98', 'F0:EE:7A', 'AC:3C:0E', '7C:50:79', 'DC:A4:CA',
  'B8:E8:56', 'D0:81:7A', 'E4:CE:8F', 'C8:6F:1D',
]

const LENOVO_OUIS = [
  '00:21:86', '3C:52:82', '54:EE:75', '7C:7A:91', 'C0:38:85',
  'F4:39:8F', 'EC:55:F9', 'A0:88:B4', 'B4:B5:2F', 'D4:3F:4A',
]

const DELL_OUIS = [
  '00:06:5B', '00:14:22', '00:1D:09', '00:1E:C9', '00:21:70',
  '00:22:19', '00:24:E8', '00:26:B9', 'D4:AE:52', 'F8:DB:88',
  'B0:83:3D', 'E4:54:E8', 'A0:36:9F', 'D0:BF:9C',
]

// ─── Real Device Catalog ───────────────────────────────────────
// Specs sourced from Apple Support, Lenovo PSREF, and Dell specs pages.

interface DeviceProfile {
  vendor: 'apple' | 'lenovo' | 'dell'
  system: { manufacturer: string; model: string; serial: string; uuid: string }
  cpu: { manufacturer: string; brand: string; cores: number; physicalCores: number }
  os: { platform: string; distro: string; arch: string; hostname: string }
  shell: string
  ouis: string[]
}

const DEVICE_CATALOG: DeviceProfile[] = [
  // ─── Apple MacBook Pro 14" M4 (2024) ───
  {
    vendor: 'apple',
    system: { manufacturer: 'Apple Inc.', model: 'Mac16,1', serial: '', uuid: '' },
    cpu: { manufacturer: 'Apple', brand: 'Apple M4', cores: 10, physicalCores: 10 },
    os: { platform: 'darwin', distro: 'macOS 15.2', arch: 'arm64', hostname: '' },
    shell: '/bin/zsh',
    ouis: APPLE_OUIS,
  },
  // ─── Apple MacBook Pro 14" M3 Pro (2023) ───
  {
    vendor: 'apple',
    system: { manufacturer: 'Apple Inc.', model: 'Mac15,3', serial: '', uuid: '' },
    cpu: { manufacturer: 'Apple', brand: 'Apple M3 Pro', cores: 12, physicalCores: 6 },
    os: { platform: 'darwin', distro: 'macOS 14.6', arch: 'arm64', hostname: '' },
    shell: '/bin/zsh',
    ouis: APPLE_OUIS,
  },
  // ─── Apple MacBook Pro 16" M3 Max (2023) ───
  {
    vendor: 'apple',
    system: { manufacturer: 'Apple Inc.', model: 'Mac15,2', serial: '', uuid: '' },
    cpu: { manufacturer: 'Apple', brand: 'Apple M3 Max', cores: 16, physicalCores: 8 },
    os: { platform: 'darwin', distro: 'macOS 14.6', arch: 'arm64', hostname: '' },
    shell: '/bin/zsh',
    ouis: APPLE_OUIS,
  },
  // ─── Apple MacBook Air 15" M3 (2024) ───
  {
    vendor: 'apple',
    system: { manufacturer: 'Apple Inc.', model: 'Mac16,3', serial: '', uuid: '' },
    cpu: { manufacturer: 'Apple', brand: 'Apple M3', cores: 8, physicalCores: 8 },
    os: { platform: 'darwin', distro: 'macOS 15.1', arch: 'arm64', hostname: '' },
    shell: '/bin/zsh',
    ouis: APPLE_OUIS,
  },
  // ─── Apple MacBook Air 13" M2 (2023) ───
  {
    vendor: 'apple',
    system: { manufacturer: 'Apple Inc.', model: 'Mac14,15', serial: '', uuid: '' },
    cpu: { manufacturer: 'Apple', brand: 'Apple M2', cores: 8, physicalCores: 8 },
    os: { platform: 'darwin', distro: 'macOS 14.4', arch: 'arm64', hostname: '' },
    shell: '/bin/zsh',
    ouis: APPLE_OUIS,
  },
  // ─── Lenovo ThinkPad X1 Carbon Gen 14 (2026) ───
  {
    vendor: 'lenovo',
    system: { manufacturer: 'LENONO', model: '21KXCTO1WW', serial: '', uuid: '' },
    cpu: { manufacturer: 'Intel', brand: 'Intel Core Ultra 7 165U v2', cores: 12, physicalCores: 6 },
    os: { platform: 'linux', distro: 'Ubuntu 24.04.2 LTS', arch: 'x64', hostname: '' },
    shell: '/bin/bash',
    ouis: LENOVO_OUIS,
  },
  // ─── Lenovo ThinkPad T14 Gen 7 (2025) ───
  {
    vendor: 'lenovo',
    system: { manufacturer: 'LENOVO', model: '21M1CTO1WW', serial: '', uuid: '' },
    cpu: { manufacturer: 'Intel', brand: 'Intel Core Ultra 5 125U v2', cores: 10, physicalCores: 5 },
    os: { platform: 'linux', distro: 'Ubuntu 24.04.1 LTS', arch: 'x64', hostname: '' },
    shell: '/bin/bash',
    ouis: LENOVO_OUIS,
  },
  // ─── Lenovo ThinkPad P14s Gen 5 (AMD) ───
  {
    vendor: 'lenovo',
    system: { manufacturer: 'LENOVO', model: '21JGCTO1WW', serial: '', uuid: '' },
    cpu: { manufacturer: 'AMD', brand: 'AMD Ryzen 7 PRO 8840HS', cores: 8, physicalCores: 8 },
    os: { platform: 'linux', distro: 'Ubuntu 24.04 LTS', arch: 'x64', hostname: '' },
    shell: '/bin/bash',
    ouis: LENOVO_OUIS,
  },
  // ─── Dell XPS 15 9530 (2023) ───
  {
    vendor: 'dell',
    system: { manufacturer: 'Dell Inc.', model: 'XPS 15 9530', serial: '', uuid: '' },
    cpu: { manufacturer: 'Intel', brand: 'Intel Core i7-13700H', cores: 14, physicalCores: 6 },
    os: { platform: 'linux', distro: 'Ubuntu 24.04 LTS', arch: 'x64', hostname: '' },
    shell: '/bin/bash',
    ouis: DELL_OUIS,
  },
  // ─── Dell XPS 13 9340 (2024) ───
  {
    vendor: 'dell',
    system: { manufacturer: 'Dell Inc.', model: 'XPS 13 9340', serial: '', uuid: '' },
    cpu: { manufacturer: 'Intel', brand: 'Intel Core Ultra 7 155H', cores: 16, physicalCores: 6 },
    os: { platform: 'linux', distro: 'Ubuntu 24.04.1 LTS', arch: 'x64', hostname: '' },
    shell: '/bin/bash',
    ouis: DELL_OUIS,
  },
  // ─── Dell Precision 5490 (2024) ───
  {
    vendor: 'dell',
    system: { manufacturer: 'Dell Inc.', model: 'Precision 5490', serial: '', uuid: '' },
    cpu: { manufacturer: 'Intel', brand: 'Intel Core Ultra 9 185H', cores: 16, physicalCores: 6 },
    os: { platform: 'linux', distro: 'Ubuntu 24.04 LTS', arch: 'x64', hostname: '' },
    shell: '/bin/bash',
    ouis: DELL_OUIS,
  },
]

// ─── Seeded RNG (deterministic per account) ────────────────────

function seededRng(seed: string): () => number {
  let h = 0n
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31n + BigInt(seed.charCodeAt(i))) & 0xFFFFFFFFn
  }
  return () => {
    h = (h * 1664525n + 1013904223n) & 0xFFFFFFFFn
    return Number(h) / 0x100000000
  }
}

function pick<T>(arr: T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)]
}

// ─── MAC Address Generation ────────────────────────────────────
// Uses a real vendor OUI prefix + locally-administered suffix.
// The locally-administered bit (bit 1 of first byte) is set so
// these addresses can never collide with a real NIC.

function generateMac(oui: string, rng: () => number): string {
  // Set locally-administered bit: flip bit 1 of first octet
  const firstOctet = parseInt(oui.split(':')[0], 16)
  const localOctet = (firstOctet | 0x02).toString(16).padStart(2, '0').toUpperCase()

  const suffix = []
  for (let i = 0; i < 3; i++) {
    suffix.push(Math.floor(rng() * 256).toString(16).padStart(2, '0').toUpperCase())
  }
  return `${localOctet}:${oui.split(':').slice(1).join(':')}:${suffix.join(':')}`
}

// ─── Machine ID Generation ─────────────────────────────────────
// Real macOS machine IDs are 32-char hex. Linux /etc/machine-id
// is 32-char hex. We generate a plausible one.

function generateMachineId(rng: () => number): string {
  const chars = '0123456789abcdef'
  let out = ''
  for (let i = 0; i < 32; i++) {
    out += chars[Math.floor(rng() * 16)]
  }
  return out
}

// ─── Serial / UUID Generation ──────────────────────────────────

function generateSerial(rng: () => number): string {
  const chars = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'
  let out = ''
  for (let i = 0; i < 12; i++) {
    out += chars[Math.floor(rng() * chars.length)]
  }
  return out
}

function generateUuid(rng: () => number): string {
  const hex = '0123456789abcdef'
  const parts: string[] = []
  for (let i = 0; i < 32; i++) {
    parts.push(hex[Math.floor(rng() * 16)])
  }
  const s = parts.join('')
  return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`
}

function generateHostname(profile: DeviceProfile, rng: () => number): string {
  const prefixes = ['dev', 'work', 'laptop', 'mbp', 'studio', 'thinkpad', 'xps', 'home']
  const suffixes = ['pro', 'local', 'lan', 'dev', 'box', 'desk']
  return `${pick(prefixes, rng)}-${pick(suffixes, rng)}`
}

// ─── Public API ─────────────────────────────────────────────────

export interface FingerprintResult {
  fingerprintId: string
  /** Device info for ads API (os, timezone, locale) */
  deviceInfo: { os: string; timezone: string; locale: string }
}

export function generateSyntheticFingerprint(accountId: string): FingerprintResult {
  const rng = seededRng(accountId)
  const profile = pick(DEVICE_CATALOG, rng)

  // Generate stable per-account values
  const machineId = generateMachineId(rng)
  const serial = generateSerial(rng)
  const uuid = generateUuid(rng)
  const hostname = generateHostname(profile, rng)

  // Generate 1-2 MAC addresses (real CLI uses all non-internal NICs)
  const macCount = 1 + Math.floor(rng() * 2)
  const macAddresses: string[] = []
  for (let i = 0; i < macCount; i++) {
    macAddresses.push(generateMac(pick(profile.ouis, rng), rng))
  }
  macAddresses.sort()

  // Build fingerprintInfo in the EXACT shape the CLI uses
  const fingerprintInfo = {
    system: {
      manufacturer: profile.system.manufacturer,
      model: profile.system.model,
      serial,
      uuid,
    },
    cpu: {
      manufacturer: profile.cpu.manufacturer,
      brand: profile.cpu.brand,
      cores: profile.cpu.cores,
      physicalCores: profile.cpu.physicalCores,
    },
    os: {
      platform: profile.os.platform,
      distro: profile.os.distro,
      arch: profile.os.arch,
      hostname,
    },
    runtime: {
      nodeVersion: 'v22.14.0',
      platform: profile.os.platform,
      arch: profile.os.arch,
      shell: profile.shell,
      cpuCount: profile.cpu.cores,
    },
    network: {
      macAddresses,
      interfaceCount: macCount,
    },
    machineId,
    fingerprintVersion: '2.0',
  }

  const fingerprintString = JSON.stringify(fingerprintInfo)
  const fingerprintHash = createHash('sha256')
    .update(fingerprintString)
    .digest('base64url')

  const fingerprintId = `enhanced-${fingerprintHash}`

  // Map to ads API os values
  const osMap: Record<string, string> = {
    darwin: 'macos',
    linux: 'linux',
    win32: 'windows',
  }
  const os = osMap[profile.os.platform] ?? 'linux'

  return {
    fingerprintId,
    deviceInfo: {
      os,
      // Real CLI uses Intl.DateTimeFormat().resolvedOptions().timeZone
      // We use common real timezones to avoid fingerprinting our server location
      timezone: pick(
        ['America/New_York', 'America/Los_Angeles', 'America/Chicago', 'America/Denver', 'Europe/London', 'Europe/Berlin'],
        rng,
      ),
      locale: pick(['en-US', 'en-GB', 'en-CA'], rng),
    },
  }
}
