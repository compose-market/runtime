# connectors

Compose's unified tools/onchain connector service. One Cloudflare Worker
hosts the catalog, credential gate, broker, GOAT runtime, and seed /
screen / metadata-agent / publish / embed / health / gc workflows. All 9000+ MCP servers from
`registry.modelcontextprotocol.io` and the GHCR pipeline at
`ghcr.io/compose-market/mcp/<slug>` are addressable as paths under one
subdomain.

## URL layout

`connectors.compose.market/<group>/<slug>/<action>[/<tool>]`

### MCP (group = `tools`)

| Method | Path                              | Auth   | Purpose                                            |
|--------|-----------------------------------|--------|----------------------------------------------------|
| GET    | `/tools`                          | public | list MCP servers                                   |
| GET    | `/tools/categories`               | public | distinct categories                                |
| GET    | `/tools/tags`                     | public | distinct tags                                      |
| GET    | `/tools/meta`                     | public | counts by origin/status                            |
| GET    | `/tools/:slug`                    | public | server card                                        |
| GET    | `/tools/:slug/tools`              | public | tool listing                                       |
| GET    | `/tools/:slug/spawn`              | public | top-priority spawn config                          |
| POST   | `/tools/:slug/execute/:tool`      | bearer | execute MCP tool                                   |
| POST   | `/tools/:slug/inspect`            | bearer | probe candidate spawn configs                      |

### GOAT (group = `onchain`)

| Method | Path                              | Auth   | Purpose                                            |
|--------|-----------------------------------|--------|----------------------------------------------------|
| GET    | `/onchain`                        | public | list GOAT plugins + treasury status                |
| GET    | `/onchain/:slug`                  | public | plugin card                                        |
| POST   | `/onchain/:slug/execute/:tool`    | bearer | execute GOAT tool                                  |

### Internal (workflow triggers)

| Method | Path        | Auth   | Purpose                          |
|--------|-------------|--------|----------------------------------|
| POST   | `/seed`     | bearer | refresh catalog from MCP registry + GHCR |
| POST   | `/verify`   | bearer | first-pass state-machine screening        |
| POST   | `/metadata-agents/run` | bearer | run one model-backed metadata shard |
| POST   | `/publish`  | bearer | publish agent artifacts to final catalog  |
| POST   | `/embed`    | bearer | upsert Vectorize entries for final catalog cards |
| POST   | `/health`   | bearer | rollup health buckets, quarantine drift   |
| POST   | `/gc`       | bearer | prune R2 + revive aged quarantines        |

Bearer auth uses `RUNTIME_INTERNAL_SECRET` — the same secret
`runtime/.env:64` defines and that the runtime's `/internal/workflow/*`
routes already validate. No new secret was minted.

## Identity envelope

`POST /tools/:slug/execute/:tool` accepts:

```json
{
  "args": {},
  "identity": {
    "agentWallet": "0x...",
    "userAddress": "0x...",
    "composeRunId": "uuid",
    "threadId": "...",
    "workflowWallet": "0x...",
    "mode": "global|local",
    "haiId": "..."
  },
  "envProvided": { "OPENAI_API_KEY": "sk-..." },
  "deadlineMs": 60000
}
```

Identity primitives come from
`runtime/src/manowar/agent/context.ts:AgentExecutionContext` and
`runtime/src/manowar/agent/memory-scope.ts:ResolvedMemoryScope`. No new
identity fields exist.

## Layout

```
runtime/src/connectors/
├── client.ts            ← runtime-side HTTP client (replaces mcps/{mcp,goat}.ts)
├── index.ts             ← public re-exports
├── types.ts             ← shared types (mirrors AgentExecutionContext)
├── package.json
├── wrangler.toml
├── tsconfig.json
├── schema/
│   └── catalog.sql      ← D1 DDL (screenings, agent reviews, servers, transports, tools, credentials, health, aliases, versions, runs)
├── worker/
│   ├── entry.ts         ← Hono app + scheduled() handler
│   ├── env.ts           ← bindings + minimal CF type stubs
│   ├── auth.ts          ← Bearer middleware
│   ├── broker.ts        ← unified execute / list dispatcher
│   ├── goat.ts          ← GOAT runtime (treasury wallet + plugin imports)
│   ├── credentials.ts   ← typed signal extraction (no heuristics)
│   └── routes/
│       ├── tools.ts     ← MCP routes
│       └── onchain.ts   ← GOAT routes
├── catalog/
│   ├── d1.ts            ← prepared statements
│   ├── spawn.ts         ← transport priority resolver
│   └── embeddings.ts    ← Voyage via Mongo AI Gateway
├── container/
│   └── transports/
│       └── http.ts      ← MCP-over-Streamable-HTTP client (clean rewrite)
├── workflows/
│   ├── seed.ts          ← MCP Registry + GHCR → D1/R2
│   ├── verify.ts        ← first-pass transport screening
│   ├── screening.ts     ← screening + metadata artifact keys/types
│   ├── metadata/        ← model-backed metadata agents
│   ├── publish.ts       ← agent artifacts → final catalog
│   ├── embed.ts         ← final catalog → Voyage + Vectorize
│   ├── health.ts        ← bucket rollup + quarantine
│   ├── inspect.ts       ← inspect candidate configs
│   └── gc.ts            ← R2 lifecycle + quarantine revival
└── tests/
    ├── credentials.test.ts
    └── error-contract.test.ts
```

## Deploying

Prerequisites:
- A Cloudflare account with `wrangler` configured (env vars
  `CF_API_TOKEN`, `CF_ACCOUNT_ID` from `runtime/.env:165-167`).
- D1 database, R2 buckets, Vectorize index, Workers AI binding created
  ahead of time and wired into `wrangler.toml`.

```bash
cd runtime/src/connectors
npm install
npm run schema:apply         # apply schema/catalog.sql to remote D1
wrangler secret put RUNTIME_INTERNAL_SECRET
wrangler secret put MONGO_DB_API_KEY
wrangler secret put SERVER_PRIVATE_KEY
wrangler secret put GOOGLE_GENERATIVE_AI_API_KEY
wrangler secret put FIREWORKS_API_KEY
wrangler deploy
```

After first deploy, start the full Cloudflare-owned pipeline:

```bash
curl -X POST https://connectors.compose.market/pipeline/run \
  -H "Authorization: Bearer $RUNTIME_INTERNAL_SECRET" \
  -H "Content-Type: application/json" \
  --data '{"mode":"first-pass"}'
```

The Workflow performs seed -> verify -> metadata agents -> publish -> embed
-> health -> gc, and each step skips already-complete rows. Subsequent runs
are driven by the single daily full-pipeline cron in `wrangler.toml`.

## What replaced what

| Old                                                 | New                                                       |
|-----------------------------------------------------|-----------------------------------------------------------|
| `runtime/src/mcps/mcp.ts` (in-process spawn)        | `runtime/src/connectors/client.ts` + Worker `broker.ts`   |
| `runtime/src/mcps/goat.ts` (runtime-VM viem wallet) | `runtime/src/connectors/worker/goat.ts` (Worker secret)   |
| `runtime/src/mcps/transports/{docker,http,npx}.ts`  | `runtime/src/connectors/container/transports/http.ts` (HTTP only; container DO is the next building block for stdio/npx/docker) |
| `services/connector/src/server.ts` (Express)        | `runtime/src/connectors/worker/entry.ts` (Hono on Workers) |
| `services/connector/src/registry.ts` (filesystem JSON loaders) | `runtime/src/connectors/catalog/d1.ts` (D1)         |
| `services/connector/scripts/sync-{glama,mcp-so,pulsemcp}.ts` | archived to `external/_archived/connector-sync-scripts/` |
| `services/connector/scripts/sync-mcp-registry.ts` + `sync-ghcr.ts` | merged into `workflows/seed.ts` |
| `services/connector/scripts/mcp-compiler/` (Python) | `workflows/metadata/agents.ts` + `workflows/publish.ts`   |

The mcp/ repo's pipeline (sync-registry.yml + build-mcp-containers.yml +
the supergateway-wrapped Dockerfile) is **untouched**. It continues to
publish images to `ghcr.io/compose-market/mcp/<slug>`. The connectors
seed workflow consumes those images.
