// Validate every package manifest under mcp/ skill/ provider/. Run in CI on PRs.
//   bun scripts/validate.ts            (also checks that file-step URLs resolve)
//   CHECK_URLS=0 bun scripts/validate.ts   (skip network reachability)
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const CATEGORIES = ['mcp', 'skill', 'provider'] as const

const errors: string[] = []
const warnings: string[] = []
const err = (file: string, msg: string) => errors.push(`${file}: ${msg}`)
const warn = (file: string, msg: string) => warnings.push(`${file}: ${msg}`)

type Manifest = Record<string, any>

async function validateFile(category: string, filename: string): Promise<void> {
  const rel = `${category}/${filename}`
  let m: Manifest
  try {
    m = JSON.parse(readFileSync(join(ROOT, category, filename), 'utf-8'))
  } catch (e) {
    err(rel, `invalid JSON: ${(e as Error).message}`)
    return
  }

  const slug = filename.replace(/\.json$/, '')
  if (m.slug !== slug) err(rel, `slug "${m.slug}" must match filename "${slug}"`)
  if (!/^[a-z0-9-]+$/.test(m.slug ?? '')) err(rel, 'slug must be kebab-case ([a-z0-9-])')
  if (m.category !== category) err(rel, `category "${m.category}" must match directory "${category}"`)
  for (const f of ['name', 'description', 'version']) if (!m[f]) err(rel, `missing ${f}`)
  if (!m.publisher?.slug || !m.publisher?.name) err(rel, 'missing publisher.slug / publisher.name')
  if (!Array.isArray(m.compatibleWith) || m.compatibleWith.length === 0) err(rel, 'compatibleWith must be a non-empty array')

  const steps = m.installHook?.steps
  if (!Array.isArray(steps)) {
    err(rel, 'installHook.steps must be an array')
    return
  }
  for (const s of steps) {
    if (s.type === 'file') {
      if (!s.url || !s.dest) err(rel, 'file step needs url + dest')
    } else if (s.type === 'config') {
      if (typeof s.patch !== 'object') err(rel, 'config step needs a patch object')
    } else if (s.type === 'script') {
      if (!s.command) err(rel, 'script step needs a command')
    } else {
      err(rel, `unknown install step type "${s.type}"`)
    }
  }

  // Category-specific installability.
  if (category === 'skill') {
    if (!steps.some((s: any) => s.type === 'file') && !m.metadata?.contentUrl) {
      err(rel, 'skill needs a file install step (or metadata.contentUrl) so it can be fetched')
    }
  } else if (category === 'mcp') {
    const t = m.metadata?.transport
    if (t === 'stdio' && !m.metadata?.serverCommand) err(rel, 'stdio MCP needs metadata.serverCommand')
    if ((t === 'http' || t === 'sse') && !m.metadata?.url) err(rel, 'remote MCP needs metadata.url')
  } else if (category === 'provider') {
    if (!steps.some((s: any) => s.type === 'config')) warn(rel, 'provider usually has a config step to pre-fill the connection')
  }

  // Best-effort reachability of file-step URLs (skippable with CHECK_URLS=0).
  if (process.env.CHECK_URLS !== '0') {
    for (const s of steps.filter((s: any) => s.type === 'file')) {
      try {
        const res = await fetch(s.url)
        if (!res.ok) err(rel, `file url ${s.url} returned HTTP ${res.status}`)
      } catch (e) {
        err(rel, `file url ${s.url} unreachable: ${(e as Error).message}`)
      }
    }
  }
}

let count = 0
for (const cat of CATEGORIES) {
  const dir = join(ROOT, cat)
  if (!existsSync(dir)) continue
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    count++
    await validateFile(cat, f)
  }
}

if (warnings.length) {
  console.log('Warnings:')
  warnings.forEach((w) => console.log('  ⚠ ' + w))
}
if (errors.length) {
  console.error(`\n${errors.length} error(s) in ${count} manifests:`)
  errors.forEach((e) => console.error('  ✗ ' + e))
  process.exit(1)
}
console.log(`✓ All ${count} manifests valid`)
