// scripts/crawl-catalog.ts
//
// Catalog crawler (small-scale validation). Scrapes the CURRENTLY POPULAR, REAL
// provider / skill / mcp entries from public web sources and regenerates
// supabase/seed.sql. No fake / mock / example.com data — the only deterministic
// placeholder allowed is a DiceBear icon URL.
//
// Sources (verified reachable):
//   - MCP      → PulseMCP  https://api.pulsemcp.com/v0beta/servers   (rank by github_stars, npm-installable only)
//   - Provider → OpenRouter https://openrouter.ai/api/v1/providers
//   - Skill    → GitHub Search (unauthenticated) https://api.github.com/search/repositories?q=claude+skill
//
// Output: writes the full supabase/seed.sql = header + publishers + the 3 fixed
// TEST providers (local / yls / skyapi, real configs, tagged 'test') + all
// crawled items, ordered by (category, downloads desc).
//
// Run: bun scripts/crawl-catalog.ts   (or: bun run crawl:catalog)

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── The single knob: bump to 50 for the full-scale pass ───────────────────────
const PER_CATEGORY_LIMIT = 10

// Well-known publisher slugs that map to the 'official' tier.
const OFFICIAL_PUBLISHERS = new Set([
  'anthropic',
  'anthropics',
  'openai',
  'google',
  'googleapis',
  'openrouter',
  'modelcontextprotocol',
])

// ── Normalized row shapes ─────────────────────────────────────────────────────
interface CrawledPublisher {
  slug: string
  name: string
  avatarUrl: string
  tier: 'official' | 'verified' | 'community'
  bio: string | null
}

interface CrawledItem {
  slug: string
  name: string
  description: string
  category: 'provider' | 'skill' | 'mcp'
  version: string
  publisherSlug: string
  compatibleWith: string[]
  tags: string[]
  downloads: number
  installHook: Record<string, unknown>
  metadata: Record<string, unknown>
}

// ── Small utilities ───────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function sanitizeSlug(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'item'
  )
}

/** Ensure slug uniqueness across the whole catalog by suffixing collisions. */
function uniqueSlug(base: string, taken: Set<string>): string {
  let slug = base
  let n = 2
  while (taken.has(slug)) slug = `${base}-${n++}`
  taken.add(slug)
  return slug
}

function githubOwnerFrom(url: string | null | undefined): string | null {
  if (!url) return null
  const m = url.match(/github\.com\/([^/]+)\/[^/]+/i)
  return m ? m[1] : null
}

function tierFor(slug: string): 'official' | 'community' {
  return OFFICIAL_PUBLISHERS.has(slug) ? 'official' : 'community'
}

async function fetchJson<T>(
  url: string,
  { retries = 3, retryDelayMs = 400, headers = {} }: { retries?: number; retryDelayMs?: number; headers?: Record<string, string> } = {}
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'agent-store-crawler', ...headers } })
      const body = await res.json()
      // PulseMCP v0beta returns HTTP 200 with an { error: { code: 'API_SUNSET' } }
      // body when it randomly fails a request as part of its sunset process.
      if (body && typeof body === 'object' && 'error' in body && (body as { error: unknown }).error) {
        throw new Error(`API error from ${url}: ${JSON.stringify((body as { error: unknown }).error)}`)
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
      return body as T
    } catch (err) {
      lastErr = err
      if (attempt < retries) await sleep(retryDelayMs)
    }
  }
  throw lastErr
}

/** Run async tasks with a bounded concurrency pool. */
async function pool<I, O>(items: I[], limit: number, fn: (item: I) => Promise<O>): Promise<O[]> {
  const out: O[] = new Array(items.length)
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx])
    }
  })
  await Promise.all(workers)
  return out
}

// ── MCP: official MCP registry (registry.modelcontextprotocol.io) ─────────────
// Replaces the deprecated PulseMCP v0beta. Free, unauthenticated, and implements
// the Generic MCP Registry API spec. PulseMCP v0.1 was the other option but now
// requires a paid API key + tenant id.
interface RegistryServer {
  server: {
    name: string
    title?: string
    description?: string
    version?: string
    packages?: Array<{ registryType?: string; identifier?: string; transport?: { type?: string } }>
    remotes?: Array<{ type: string; url: string }>
    repository?: { url?: string; source?: string }
  }
  _meta?: { 'io.modelcontextprotocol.registry/official'?: { status?: string; isLatest?: boolean } }
}
interface RegistryPage {
  servers: RegistryServer[]
  metadata?: { nextCursor?: string; count?: number }
}

// GitHub stars for a repo, used to rank MCP servers by popularity. Uses
// GITHUB_TOKEN (present in CI) to lift the rate limit; returns null if unavailable.
async function githubStars(repoUrl: string | undefined, headers: Record<string, string>): Promise<number | null> {
  const m = repoUrl?.match(/github\.com\/([^/]+)\/([^/#?]+)/i)
  if (!m) return null
  try {
    const repo = await fetchJson<{ stargazers_count: number }>(
      `https://api.github.com/repos/${m[1]}/${m[2].replace(/\.git$/, '')}`,
      { retries: 1, headers }
    )
    return repo.stargazers_count ?? null
  } catch {
    return null
  }
}

async function crawlMcp(publishers: Map<string, CrawledPublisher>, taken: Set<string>): Promise<CrawledItem[]> {
  const base = 'https://registry.modelcontextprotocol.io/v0/servers'

  // Collect active, latest servers across a few pages.
  const collected: RegistryServer['server'][] = []
  let cursor: string | undefined
  for (let page = 0; page < 4 && collected.length < 120; page++) {
    const url = `${base}?limit=100${cursor ? `&version=latest&cursor=${cursor}` : '&version=latest'}`
    let res: RegistryPage
    try {
      res = await fetchJson<RegistryPage>(url, { retries: 3 })
    } catch (err) {
      console.warn(`  [mcp] page ${page} failed: ${(err as Error).message}`)
      break
    }
    for (const s of res.servers) {
      const meta = s._meta?.['io.modelcontextprotocol.registry/official']
      if (meta && meta.status !== 'active') continue
      collected.push(s.server)
    }
    cursor = res.metadata?.nextCursor
    if (!cursor) break
  }
  console.log(`  [mcp] fetched ${collected.length} active servers from the MCP registry`)

  // Keep entries we can actually install: an npm package (→ npx stdio) or a remote.
  type McpEntry = { server: RegistryServer['server']; npmId?: string; remote?: { type: string; url: string } }
  const installable: McpEntry[] = []
  for (const server of collected) {
    const npm = server.packages?.find((p) => p.registryType === 'npm' && p.identifier)
    const remote = server.remotes?.find((r) => r.type === 'streamable-http' || r.type === 'http' || r.type === 'sse')
    if (npm?.identifier) installable.push({ server, npmId: npm.identifier })
    else if (remote) installable.push({ server, remote: { type: remote.type, url: remote.url } })
  }

  // Rank by GitHub stars (best-effort; the registry has no popularity signal).
  const ghHeaders: Record<string, string> = { Accept: 'application/vnd.github+json' }
  if (process.env.GITHUB_TOKEN) ghHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const ranked = await pool(installable.slice(0, 60), 6, async (e) => ({
    e,
    stars: (await githubStars(e.server.repository?.url, ghHeaders)) ?? 0,
  }))
  ranked.sort((a, b) => b.stars - a.stars)

  const rows: CrawledItem[] = []
  for (const { e, stars } of ranked) {
    if (rows.length >= PER_CATEGORY_LIMIT) break
    const owner = githubOwnerFrom(e.server.repository?.url)
    const pubSlug = owner ? sanitizeSlug(owner) : 'community'
    if (!publishers.has(pubSlug)) {
      publishers.set(pubSlug, {
        slug: pubSlug,
        name: owner ?? 'Community',
        avatarUrl: owner ? `https://github.com/${owner}.png` : `https://api.dicebear.com/9.x/shapes/svg?seed=${pubSlug}`,
        tier: tierFor(pubSlug),
        bio: null,
      })
    }
    // Registry names look like "io.github.owner/name"; use the last segment for the slug.
    const shortName = e.server.name.split('/').pop() || e.server.name
    const slug = uniqueSlug(sanitizeSlug(e.npmId || shortName), taken)
    const remoteMeta = e.remote
      ? { transport: e.remote.type === 'sse' ? 'sse' : 'http', url: e.remote.url, configSchema: {} }
      : { transport: 'stdio', serverCommand: `npx -y ${e.npmId}`, configSchema: {} }
    rows.push({
      slug,
      name: e.server.title || shortName,
      description: e.server.description || shortName,
      category: 'mcp',
      version: '1.0.0',
      publisherSlug: pubSlug,
      compatibleWith: ['claude', 'codex'],
      tags: ['mcp', e.remote ? e.remote.type : 'npm'],
      downloads: stars,
      installHook: { steps: [] },
      metadata: remoteMeta,
    })
  }
  return rows
}

// ── Provider: curated real providers with known endpoints ────────────────────
// Providers aren't mass-crawlable — there is no registry of relay endpoints, and a
// provider's baseURL is fixed and provided by the provider. So this is a curated
// list. Each entry pre-fills its baseURL + auth via a config install step; the user
// only supplies their API key.
interface CuratedProvider {
  slug: string
  name: string
  publisherSlug: string
  publisherName: string
  bio: string
  description: string
  compatibleWith: string[]
  connection: { baseUrl: string; authType: string; endpointPath?: string; upstreamProtocol?: string; level?: number }
  modelsUrl?: string
  configSchema: Record<string, unknown>
}

const CURATED_PROVIDERS: CuratedProvider[] = [
  {
    slug: 'openrouter',
    name: 'OpenRouter',
    publisherSlug: 'openrouter',
    publisherName: 'OpenRouter',
    bio: '统一访问 300+ 模型的推理路由服务。',
    description: 'OpenRouter：一个 API Key 访问 300+ 模型（OpenAI 兼容）。此预设已填好接入地址，你只需填入自己的 OpenRouter API Key。',
    compatibleWith: ['codex'],
    connection: { baseUrl: 'https://openrouter.ai/api/v1', authType: 'bearer', endpointPath: '/chat/completions', upstreamProtocol: 'auto', level: 1 },
    modelsUrl: 'https://openrouter.ai/api/v1/models',
    configSchema: {
      type: 'object',
      required: ['apiKey'],
      properties: {
        apiKey: { type: 'string', description: 'OpenRouter API Key (Bearer)' },
        baseUrl: { type: 'string', description: 'API 地址', default: 'https://openrouter.ai/api/v1' },
        authType: { type: 'string', default: 'bearer' },
        level: { type: 'number', default: 1 },
      },
    },
  },
]

async function crawlProviders(publishers: Map<string, CrawledPublisher>, taken: Set<string>): Promise<CrawledItem[]> {
  const rows: CrawledItem[] = []
  for (const p of CURATED_PROVIDERS) {
    if (!publishers.has(p.publisherSlug)) {
      publishers.set(p.publisherSlug, {
        slug: p.publisherSlug,
        name: p.publisherName,
        avatarUrl: `https://api.dicebear.com/9.x/shapes/svg?seed=${p.publisherSlug}`,
        tier: tierFor(p.publisherSlug),
        bio: p.bio,
      })
    }
    let supportedModels: string[] = []
    if (p.modelsUrl) {
      try {
        const { data } = await fetchJson<{ data: Array<{ id: string }> }>(p.modelsUrl, { retries: 2 })
        supportedModels = data.slice(0, 20).map((m) => m.id)
      } catch { /* leave empty on failure */ }
    }
    const slug = uniqueSlug(sanitizeSlug(p.slug), taken)
    rows.push({
      slug,
      name: p.name,
      description: p.description,
      category: 'provider',
      version: '1.0.0',
      publisherSlug: p.publisherSlug,
      compatibleWith: p.compatibleWith,
      tags: ['provider'],
      downloads: 0,
      installHook: { steps: [{ type: 'config', patch: { apiKey: '', ...p.connection } }] },
      metadata: { configSchema: p.configSchema, supportedModels },
    })
  }
  console.log(`  [provider] emitted ${rows.length} curated providers`)
  return rows
}

// ── Skill: GitHub Search (unauthenticated) ────────────────────────────────────
interface GHRepo {
  name: string
  full_name: string
  html_url: string
  description: string | null
  stargazers_count: number
  topics?: string[]
  default_branch?: string
  owner: { login: string; avatar_url: string }
}

interface GHTree {
  tree: Array<{ path: string; type: string }>
  truncated: boolean
}

// A single SKILL.md discovered inside a repo (a repo may hold many).
interface SkillCandidate {
  owner: string
  repo: string
  branch: string
  path: string
  dir: string
  rawUrl: string
  ownerAvatar: string
  stars: number
}

// Parse the leading YAML frontmatter of a SKILL.md for its name / description.
function parseSkillFrontmatter(md: string): { name?: string; description?: string } {
  const m = md.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!m) return {}
  const block = m[1]
  const strip = (v: string | undefined) => v?.trim().replace(/^["']|["']$/g, '')
  return {
    name: strip(block.match(/^name:\s*(.+)$/m)?.[1]),
    description: strip(block.match(/^description:\s*(.+)$/m)?.[1]),
  }
}

// Genuinely real Claude-skill repos, used only if GitHub is rate-limited.
const SKILL_FALLBACK = ['anthropics/skills', 'obra/superpowers']

async function crawlSkills(publishers: Map<string, CrawledPublisher>, taken: Set<string>): Promise<CrawledItem[]> {
  let repos: GHRepo[] = []
  let usedFallback = false
  const url = 'https://api.github.com/search/repositories?q=claude+skill&sort=stars&order=desc&per_page=15'
  // Use GITHUB_TOKEN when present (CI) to lift the 60/hr unauthenticated rate limit.
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  try {
    const res = await fetchJson<{ items: GHRepo[] }>(url, { retries: 0, headers })
    repos = res.items
  } catch (err) {
    console.warn(`  [skill] GitHub search failed (${(err as Error).message}); retrying once after 3s`)
    await sleep(3000)
    try {
      const res = await fetchJson<{ items: GHRepo[] }>(url, { retries: 0, headers })
      repos = res.items
    } catch (err2) {
      console.warn(`  [skill] GitHub still failing (${(err2 as Error).message}); using hardcoded real-repo fallback`)
      usedFallback = true
      repos = await pool(SKILL_FALLBACK, 2, async (fullName) =>
        fetchJson<GHRepo>(`https://api.github.com/repos/${fullName}`, { retries: 2, headers })
      )
    }
  }

  const searchRepos = usedFallback ? repos : repos.filter((r) => r.description && r.description.trim())

  // Scan curated seed repos first (quality), then search results; dedup by name.
  let scanRepos = searchRepos
  if (!usedFallback) {
    try {
      const seeds = await pool(SKILL_FALLBACK, 2, (fullName) =>
        fetchJson<GHRepo>(`https://api.github.com/repos/${fullName}`, { retries: 1, headers })
      )
      const seen = new Set(seeds.map((r) => r.full_name))
      scanRepos = [...seeds, ...searchRepos.filter((r) => !seen.has(r.full_name))]
    } catch { /* seeds unavailable; keep search results */ }
  }
  console.log(`  [skill] scanning ${scanRepos.length} repos (curated + search)`)

  // Walk each repo's tree (1 API call per repo). Cap per repo so one large collection
  // doesn't fill the whole quota — keeps the catalog diverse across repos.
  const PER_REPO = 3
  const candidates: SkillCandidate[] = []
  for (const r of scanRepos) {
    if (candidates.length >= PER_CATEGORY_LIMIT) break
    const [owner, repo] = r.full_name.split('/')
    const branch = r.default_branch || 'main'
    let tree: GHTree
    try {
      tree = await fetchJson<GHTree>(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
        { retries: 1, headers }
      )
    } catch (err) {
      console.warn(`  [skill] tree for ${r.full_name} failed: ${(err as Error).message}`)
      continue
    }
    let perRepo = 0
    for (const entry of tree.tree) {
      if (perRepo >= PER_REPO || candidates.length >= PER_CATEGORY_LIMIT) break
      if (entry.type !== 'blob') continue
      if (entry.path !== 'SKILL.md' && !entry.path.endsWith('/SKILL.md')) continue
      const dir = entry.path === 'SKILL.md' ? repo : entry.path.slice(0, -'/SKILL.md'.length).split('/').pop()!
      candidates.push({
        owner,
        repo,
        branch,
        path: entry.path,
        dir,
        rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${entry.path}`,
        ownerAvatar: r.owner.avatar_url,
        stars: r.stargazers_count,
      })
      perRepo++
    }
  }
  console.log(`  [skill] found ${candidates.length} SKILL.md files across ${new Set(candidates.map((c) => c.repo)).size} repos`)

  // For each chosen skill, fetch its raw SKILL.md (not rate-limited) for real
  // name/description from frontmatter, and emit a file install step that fetches it.
  const rows: CrawledItem[] = []
  for (const c of candidates.slice(0, PER_CATEGORY_LIMIT)) {
    const pubSlug = sanitizeSlug(c.owner)
    if (!publishers.has(pubSlug)) {
      publishers.set(pubSlug, { slug: pubSlug, name: c.owner, avatarUrl: c.ownerAvatar, tier: tierFor(pubSlug), bio: null })
    }
    let name = c.dir
    let description = `来自 ${c.owner}/${c.repo} 的 skill。`
    try {
      const md = await (await fetch(c.rawUrl, { headers: { 'user-agent': 'agent-store-crawler' } })).text()
      const fm = parseSkillFrontmatter(md)
      if (fm.name) name = fm.name
      if (fm.description) description = fm.description.slice(0, 300)
    } catch { /* keep dir-derived defaults */ }
    const slug = uniqueSlug(sanitizeSlug(c.dir === c.repo ? c.repo : `${c.repo}-${c.dir}`), taken)
    rows.push({
      slug,
      name,
      description,
      category: 'skill',
      version: '1.0.0',
      publisherSlug: pubSlug,
      compatibleWith: ['claude'],
      tags: ['skill'],
      downloads: c.stars,
      installHook: { steps: [{ type: 'file', url: c.rawUrl, dest: 'skill.md' }] },
      metadata: { contentUrl: c.rawUrl, source: { repo: `${c.owner}/${c.repo}`, ref: c.branch, path: c.path } },
    })
  }
  return rows
}

// ── SQL generation ────────────────────────────────────────────────────────────
function sqlText(s: string | null): string {
  if (s === null) return 'NULL'
  return `'${s.replace(/'/g, "''")}'`
}
function sqlArray(arr: string[]): string {
  if (arr.length === 0) return `'{}'`
  return `ARRAY[${arr.map((v) => sqlText(v)).join(',')}]`
}
function sqlJson(obj: Record<string, unknown>): string {
  return `${sqlText(JSON.stringify(obj))}::jsonb`
}

function publisherInsert(pubs: CrawledPublisher[]): string {
  const values = pubs
    .map((p) => `  (${sqlText(p.slug)}, ${sqlText(p.name)}, ${sqlText(p.avatarUrl)}, ${sqlText(p.tier)}, ${sqlText(p.bio)})`)
    .join(',\n')
  return `INSERT INTO publishers (slug, name, avatar_url, tier, bio) VALUES\n${values};`
}

function itemInsert(it: CrawledItem): string {
  return `INSERT INTO items (
  slug, name, description,
  category, version, publisher_id,
  compatible_with, tags, downloads, rating, status,
  install_hook, metadata
) VALUES (
  ${sqlText(it.slug)}, ${sqlText(it.name)}, ${sqlText(it.description)},
  ${sqlText(it.category)}, ${sqlText(it.version)}, (SELECT id FROM publishers WHERE slug = ${sqlText(it.publisherSlug)}),
  ${sqlArray(it.compatibleWith)}, ${sqlArray(it.tags)}, ${it.downloads}, 0, 'published',
  ${sqlJson(it.installHook)}, ${sqlJson(it.metadata)}
);`
}

// The 3 TEST providers (local / yls / skyapi) with their REAL configs, copied
// verbatim from the original seed.sql and tagged 'test' so they're identifiable.
// ALWAYS emitted — the user has live yls/skyapi subscriptions used for installs.
const TEST_PUBLISHERS: CrawledPublisher[] = [
  { slug: 'agent-store', name: 'Agent Store', avatarUrl: 'https://api.dicebear.com/9.x/shapes/svg?seed=agent-store', tier: 'official', bio: 'Agent Store 官方内置组件。' },
  { slug: 'yls-me', name: 'YLS.me', avatarUrl: 'https://api.dicebear.com/9.x/shapes/svg?seed=yls', tier: 'verified', bio: '已验证的第三方模型中转服务。' },
  { slug: 'skyapi', name: 'SkyAPI', avatarUrl: 'https://api.dicebear.com/9.x/shapes/svg?seed=skyapi', tier: 'community', bio: '稳定线路、免翻墙接入 Claude Code 的第三方中转服务。' },
]

const TEST_PROVIDERS_SQL = `-- Provider: local (built-in relay) — the endpoint Claude/Codex point at; forwards
-- to upstream providers by level. No upstream API key. Rendered specially in the
-- CLI client (LOCAL_PROVIDER_SENTINEL __local__); this catalog row is its store listing.
INSERT INTO items (
  slug, name, description,
  category, version, publisher_id,
  compatible_with, tags, downloads, rating, status,
  install_hook, metadata
) VALUES (
  'local',
  '本地中转',
  '内置本地中转：将 Claude Code / Codex 的 baseURL 指向本机监听端口，请求按 Level 优先级转发到已配置的上游供应商，失败自动降级。无需 API 密钥。',
  'provider', '1.0.0',
  (SELECT id FROM publishers WHERE slug = 'agent-store'),
  ARRAY['claude','codex'], ARRAY['relay','local','内置','test'], 0, 5.0, 'published',
  $\${"steps":[]}$$,
  $\${"configSchema":{},"supportedModels":[]}$$
);

-- Provider: yls (伊莉思 Code) — real China relay for Codex CLI. Pre-fills the codex
-- endpoint connection on install; user supplies the Bearer API key.
INSERT INTO items (
  slug, name, description,
  category, version, publisher_id,
  compatible_with, tags, downloads, rating, status,
  install_hook, metadata
) VALUES (
  'yls',
  'YLS Code 中转',
  '伊莉思 Code 中转服务，国内直连免翻墙接入 Codex CLI（GPT-5 Code）与 Claude Code；此预设接入其 Codex 端点，按订阅计费。',
  'provider', '1.0.0',
  (SELECT id FROM publishers WHERE slug = 'yls-me'),
  ARRAY['codex'], ARRAY['relay','codex','国产中转','test'], 32000, 4.7, 'published',
  $\${"steps":[{"type":"config","patch":{"apiKey":"","baseUrl":"https://code.ylsagi.com/codex","authType":"bearer","upstreamProtocol":"auto","level":1}}]}$$,
  $\${"configSchema":{"type":"object","required":["apiKey"],"properties":{"apiKey":{"type":"string","description":"API 密钥 (Bearer)"},"baseUrl":{"type":"string","description":"API 地址","default":"https://code.ylsagi.com/codex"},"authType":{"type":"string","default":"bearer"},"upstreamProtocol":{"type":"string","default":"auto"},"level":{"type":"number","default":1}}},"supportedModels":["gpt-5-codex","gpt-5"]}$$
);

-- Provider: skyapi — real China relay for Claude Code (Anthropic protocol). Pre-fills
-- the claude endpoint connection on install; user supplies the x-api-key.
INSERT INTO items (
  slug, name, description,
  category, version, publisher_id,
  compatible_with, tags, downloads, rating, status,
  install_hook, metadata
) VALUES (
  'skyapi',
  'SkyAPI 中转',
  'SkyAPI 中转服务，稳定线路免翻墙接入 Claude Code，兼容 Cursor / Cline / Windsurf 等客户端。',
  'provider', '1.0.0',
  (SELECT id FROM publishers WHERE slug = 'skyapi'),
  ARRAY['claude'], ARRAY['relay','claude','国产中转','test'], 21000, 4.5, 'published',
  $\${"steps":[{"type":"config","patch":{"apiKey":"","baseUrl":"http://150.158.2.79:8888","authType":"anthropic","upstreamProtocol":"auto","level":1}}]}$$,
  $\${"configSchema":{"type":"object","required":["apiKey"],"properties":{"apiKey":{"type":"string","description":"API 密钥 (x-api-key)"},"baseUrl":{"type":"string","description":"API 地址","default":"http://150.158.2.79:8888"},"authType":{"type":"string","default":"anthropic"},"upstreamProtocol":{"type":"string","default":"auto"},"level":{"type":"number","default":1}}},"supportedModels":["claude-opus-4-8","claude-sonnet-5","claude-haiku-4-5-20251001","claude-opus-4-5"]}$$
);`

// ── Main ──────────────────────────────────────────────────────────────────────
// ── Publish mode: upsert to Supabase via PostgREST (service_role) ─────────────
// Crawled items land as status='pending' tagged metadata.source='crawler' so an
// admin reviews them before they go live, and user-submitted rows are never
// clobbered. Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
async function publishToDb(publishers: CrawledPublisher[], items: CrawledItem[]): Promise<void> {
  const baseUrl = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!baseUrl || !key) throw new Error('publish mode requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY')
  const rest = `${baseUrl.replace(/\/$/, '')}/rest/v1`
  const auth = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
  const check = async (res: Response, what: string) => {
    if (!res.ok) throw new Error(`${what} failed: HTTP ${res.status} ${await res.text()}`)
  }

  // 1. Upsert publishers by slug.
  await fetch(`${rest}/publishers?on_conflict=slug`, {
    method: 'POST',
    headers: { ...auth, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(publishers.map((p) => ({ slug: p.slug, name: p.name, avatar_url: p.avatarUrl, tier: p.tier, bio: p.bio }))),
  }).then((r) => check(r, 'publishers upsert'))

  // 2. Resolve publisher ids for the item FK.
  const pubRows = (await (await fetch(`${rest}/publishers?select=id,slug`, { headers: auth })).json()) as { id: string; slug: string }[]
  const pubId = new Map(pubRows.map((p) => [p.slug, p.id]))

  // 3. Never clobber user-submitted items — skip slugs whose existing row isn't crawler-sourced.
  const existing = (await (await fetch(`${rest}/items?select=slug,metadata&slug=in.(${items.map((i) => i.slug).join(',')})`, { headers: auth })).json()) as { slug: string; metadata: Record<string, unknown> | null }[]
  const userOwned = new Set(existing.filter((e) => (e.metadata?.['source'] ?? null) !== 'crawler').map((e) => e.slug))

  // 4. Upsert crawler items as pending, tagged source=crawler.
  const rows = items
    .filter((i) => !userOwned.has(i.slug) && pubId.has(i.publisherSlug))
    .map((i) => ({
      slug: i.slug, name: i.name, description: i.description, category: i.category, version: i.version,
      publisher_id: pubId.get(i.publisherSlug), compatible_with: i.compatibleWith, tags: i.tags,
      downloads: i.downloads, rating: 0, status: 'pending',
      install_hook: i.installHook, metadata: { ...i.metadata, source: 'crawler' },
    }))
  await fetch(`${rest}/items?on_conflict=slug`, {
    method: 'POST',
    headers: { ...auth, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  }).then((r) => check(r, 'items upsert'))

  console.log(`Published: ${publishers.length} publishers, ${rows.length} items (pending, source=crawler), skipped ${userOwned.size} user-owned`)
}

// ── Manifest mode: write one self-contained JSON manifest per package ─────────
// Bootstraps / updates the ai-agent-store/registry repo, where each package is a
// file reviewed via PR. The publisher is embedded so each manifest stands alone.
function writeManifests(dir: string, publisherMap: Map<string, CrawledPublisher>, items: CrawledItem[]): void {
  for (const item of items) {
    const { publisherSlug, ...rest } = item
    const pub = publisherMap.get(publisherSlug)
    const manifest = {
      $schema: '../schema/package.schema.json',
      ...rest,
      publisher: pub
        ? { slug: pub.slug, name: pub.name, tier: pub.tier, avatarUrl: pub.avatarUrl, bio: pub.bio }
        : { slug: publisherSlug, name: publisherSlug, tier: 'community', avatarUrl: '', bio: null },
    }
    const catDir = join(dir, item.category)
    mkdirSync(catDir, { recursive: true })
    writeFileSync(join(catDir, `${item.slug}.json`), JSON.stringify(manifest, null, 2) + '\n')
  }
  console.log(`Wrote ${items.length} manifests to ${dir}/`)
}

async function main() {
  console.log(`Crawling catalog (PER_CATEGORY_LIMIT=${PER_CATEGORY_LIMIT})...`)

  const publishers = new Map<string, CrawledPublisher>()
  // Reserve the test slugs so crawled entries never collide with them.
  const takenSlugs = new Set<string>(['local', 'yls', 'skyapi'])
  const takenPublishers = new Set<string>(TEST_PUBLISHERS.map((p) => p.slug))

  // Each adapter is independently guarded: one source failing must not abort the run.
  const guard = async (label: string, fn: () => Promise<CrawledItem[]>): Promise<CrawledItem[]> => {
    try {
      return await fn()
    } catch (err) {
      console.warn(`  [${label}] adapter failed entirely: ${(err as Error).message}`)
      return []
    }
  }

  const [mcp, providers, skills] = await Promise.all([
    guard('mcp', () => crawlMcp(publishers, takenSlugs)),
    guard('provider', () => crawlProviders(publishers, takenSlugs)),
    guard('skill', () => crawlSkills(publishers, takenSlugs)),
  ])

  const items = [...mcp, ...providers, ...skills]
  // Deterministic ordering: category asc, then downloads desc.
  items.sort((a, b) => a.category.localeCompare(b.category) || b.downloads - a.downloads)

  // Crawled publishers, excluding any that collide with the fixed test publishers.
  const crawledPublishers = [...publishers.values()]
    .filter((p) => !takenPublishers.has(p.slug))
    .sort((a, b) => a.slug.localeCompare(b.slug))

  // Publish mode: upsert crawled rows into the live DB as pending instead of
  // regenerating the local seed file.
  if (process.argv.includes('--publish')) {
    await publishToDb(crawledPublishers, items)
    return
  }

  // Manifest mode: write per-package JSON files for the registry repo.
  const manifestsIdx = process.argv.indexOf('--manifests')
  if (manifestsIdx !== -1) {
    writeManifests(process.argv[manifestsIdx + 1] ?? 'registry', publishers, items)
    return
  }

  const header = `-- supabase/seed.sql
-- GENERATED by scripts/crawl-catalog.ts — DO NOT EDIT BY HAND.
-- Regenerate with: bun run crawl:catalog
--
-- Point-in-time snapshot (${new Date().toISOString()}) of the currently popular,
-- REAL provider / skill / mcp entries crawled from public sources:
--   provider → OpenRouter, skill → GitHub, mcp → PulseMCP.
-- Plus the 3 fixed TEST providers (local / yls / skyapi, tagged 'test').
-- Counts: mcp=${mcp.length}, provider=${providers.length}, skill=${skills.length} (+3 test providers).
`

  const parts: string[] = [
    header,
    '-- ── Publishers (test publishers + crawled) ──────────────────────────────────',
    publisherInsert([...TEST_PUBLISHERS, ...crawledPublishers]),
    '',
    '-- ── TEST providers (always present, real configs) ───────────────────────────',
    TEST_PROVIDERS_SQL,
    '',
    '-- ── Crawled items (real, popularity-ranked) ─────────────────────────────────',
    ...items.map(itemInsert),
    '',
  ]

  const seedPath = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'supabase', 'seed.sql')
  writeFileSync(seedPath, parts.join('\n') + '\n')

  console.log('')
  console.log(`Wrote ${seedPath}`)
  console.log(`  publishers: ${TEST_PUBLISHERS.length} test + ${crawledPublishers.length} crawled`)
  console.log(`  items: mcp=${mcp.length}, provider=${providers.length}, skill=${skills.length}, +3 test providers`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
