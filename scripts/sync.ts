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
// Existing slugs, so we set the downloads baseline only on NEW inserts and preserve
// accumulated real-install counts on updates (downloads is store-owned once created).
const existingRows = (await (await fetch(`${rest}/items?select=slug`, { headers: auth })).json()) as { slug: string }[]
const existingSlugs = new Set(existingRows.map((r) => r.slug))

const eligible = items.filter((i) => pubId.has(i.publisher?.slug))
const baseRow = (i: Manifest) => ({
  slug: i.slug, name: i.name, description: i.description, category: i.category, version: i.version,
  publisher_id: pubId.get(i.publisher.slug), compatible_with: i.compatibleWith, tags: i.tags ?? [],
  status: 'published', install_hook: i.installHook, metadata: { ...(i.metadata ?? {}), source: 'registry' },
})
const batches: [string, Record<string, unknown>[]][] = [
  ['new', eligible.filter((i) => !existingSlugs.has(i.slug)).map((i) => ({ ...baseRow(i), downloads: i.downloads ?? 0 }))],
  ['update', eligible.filter((i) => existingSlugs.has(i.slug)).map(baseRow)],
]
for (const [label, batch] of batches) {
  if (!batch.length) continue
  await fetch(`${rest}/items?on_conflict=slug`, {
    method: 'POST',
    headers: { ...auth, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(batch),
  }).then((r) => check(r, `items upsert (${label})`))
}
const rows = eligible

// 3b. Record version history — one row per (slug, version), first time seen.
// Ignore-duplicates so re-syncing the same version is a no-op; new versions
// append, building a real timeline over time.
const versionRows = eligible.map((i) => ({ item_slug: i.slug, version: i.version }))
if (versionRows.length) {
  await fetch(`${rest}/item_versions?on_conflict=item_slug,version`, {
    method: 'POST',
    headers: { ...auth, Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify(versionRows),
  }).then((r) => check(r, 'item_versions'))
}

// 4. Reconcile: the registry is the single source of truth, so unpublish any
// published item not backed by a current manifest — except the built-in test
// providers, which are seeded separately.
const PRESERVE = new Set(['local', 'yls', 'skyapi'])
const currentSlugs = new Set(rows.map((r) => r.slug))
const published = (await (await fetch(`${rest}/items?select=slug&status=eq.published`, { headers: auth })).json()) as { slug: string }[]
const stale = published.filter((p) => !currentSlugs.has(p.slug) && !PRESERVE.has(p.slug)).map((p) => p.slug)
if (stale.length) {
  await fetch(`${rest}/items?slug=in.(${stale.join(',')})`, {
    method: 'PATCH',
    headers: { ...auth, Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'rejected' }),
  }).then((r) => check(r, 'reconcile'))
  console.log(`Unpublished ${stale.length} removed package(s): ${stale.join(', ')}`)
}

console.log(`Synced ${pubMap.size} publishers, ${rows.length} items (published)`)
