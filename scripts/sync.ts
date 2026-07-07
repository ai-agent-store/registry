// Sync all merged manifests into the store DB as published items. Runs in CI on
// push to main (i.e. after a PR merges). Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('sync requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
const rest = `${url.replace(/\/$/, '')}/rest/v1`
const auth = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }

async function check(res: Response, what: string): Promise<void> {
  if (!res.ok) {
    console.error(`${what}: HTTP ${res.status} ${await res.text()}`)
    process.exit(1)
  }
}

type Manifest = Record<string, any>

const items: Manifest[] = []
for (const cat of ['mcp', 'skill', 'provider']) {
  const dir = join(ROOT, cat)
  if (!existsSync(dir)) continue
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    items.push(JSON.parse(readFileSync(join(dir, f), 'utf-8')))
  }
}

// Dedupe publishers embedded in the manifests.
const pubMap = new Map<string, Manifest>()
for (const it of items) if (it.publisher?.slug) pubMap.set(it.publisher.slug, it.publisher)

// 1. Upsert publishers.
await fetch(`${rest}/publishers?on_conflict=slug`, {
  method: 'POST',
  headers: { ...auth, Prefer: 'resolution=merge-duplicates,return=minimal' },
  body: JSON.stringify(
    [...pubMap.values()].map((p) => ({ slug: p.slug, name: p.name, avatar_url: p.avatarUrl ?? '', tier: p.tier ?? 'community', bio: p.bio ?? null }))
  ),
}).then((r) => check(r, 'publishers upsert'))

// 2. Resolve publisher ids.
const pubRows = (await (await fetch(`${rest}/publishers?select=id,slug`, { headers: auth })).json()) as { id: string; slug: string }[]
const pubId = new Map(pubRows.map((p) => [p.slug, p.id]))

// 3. Upsert items as published (the registry is the reviewed source of truth).
const rows = items
  .filter((i) => pubId.has(i.publisher?.slug))
  .map((i) => ({
    slug: i.slug, name: i.name, description: i.description, category: i.category, version: i.version,
    publisher_id: pubId.get(i.publisher.slug), compatible_with: i.compatibleWith, tags: i.tags ?? [],
    downloads: i.downloads ?? 0, status: 'published', install_hook: i.installHook,
    metadata: { ...(i.metadata ?? {}), source: 'registry' },
  }))
await fetch(`${rest}/items?on_conflict=slug`, {
  method: 'POST',
  headers: { ...auth, Prefer: 'resolution=merge-duplicates,return=minimal' },
  body: JSON.stringify(rows),
}).then((r) => check(r, 'items upsert'))

console.log(`Synced ${pubMap.size} publishers, ${rows.length} items (published)`)
