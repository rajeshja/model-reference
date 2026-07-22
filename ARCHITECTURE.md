# ARCHITECTURE.md — Model Curator

## 1. High-Level Shape

A single Cloudflare project with two moving parts:

- **Cloudflare Pages** (or a Pages-integrated Worker via `@cloudflare/next-on-pages` / plain static build) — serves the frontend SPA.
- **Cloudflare Worker (Pages Functions or a standalone Worker)** — the API layer: CRUD on models, provider-sync orchestration, auth, secrets access.
- **Cloudflare D1** — primary relational store (models, pricing variants, providers, sync history).
- **Cloudflare KV** — short-TTL cache for raw provider catalog responses (avoid re-hitting provider APIs on every page load) and for holding the "pending new models found by sync" review queue.
- **Cloudflare Cron Trigger** — scheduled Worker invocation (e.g., daily) that runs the sync job against each connected provider.
- **Cloudflare Secrets (Worker environment secrets / D1-stored encrypted keys)** — provider API keys.

```
┌─────────────┐      ┌────────────────────┐      ┌──────────────┐
│  Pages SPA  │────▶ │  Worker API (Hono)  │────▶ │  D1 (SQLite)  │
│ (React/     │◀──── │  /api/*             │◀──── │  models etc.  │
│  Vite, TS)  │      └─────────┬───────────┘      └──────────────┘
└─────────────┘                │
                                ▼
                      ┌───────────────────┐        ┌───────────────┐
                      │  KV (catalog       │        │  Cron Trigger  │
                      │  cache, review     │◀───────│  (daily sync)  │
                      │  queue)            │        └───────────────┘
                      └─────────┬──────────┘
                                ▼
              ┌─────────────────────────────────────────┐
              │ Provider APIs: OpenRouter / OpenAI /      │
              │ Anthropic / Google (Gemini)                │
              └─────────────────────────────────────────┘
```

This is a single Cloudflare Pages project with Functions — no separate hosting needed. Everything (frontend + API) deploys from one `wrangler`/Pages build.

## 2. Why This Stack

- **Cloudflare Pages + Workers**: matches the explicit ask, generous free tier, zero server management, Worker cron covers the scheduled sync requirement without a separate cron host.
- **D1** over KV-as-primary-store: the data is genuinely relational (models → pricing variants, providers → models, sync history), benefits from real queries (filter/sort could eventually move server-side if the catalog grows large), and D1's SQLite-on-the-edge model fits a low-write, read-heavy app well.
- **KV** as a cache/queue layer, not the source of truth: provider catalog responses are large (OpenRouter alone returns 300+ models) and don't need to be persisted verbatim — cache them with a TTL (e.g., 1 hour) so repeated syncs/UI refreshes within that window don't re-hit the provider, and use KV for the transient "candidate models found by last sync, awaiting user review" list, which is disposable state.
- **Hono** (or itty-router) as the Worker-side framework: lightweight, first-class Cloudflare Workers support, good TypeScript ergonomics, easy to colocate with Pages Functions.
- **React + Vite + TypeScript** for the frontend: matches "mobile-first single table" needs well with something like TanStack Table (headless, handles sort/filter/virtualization without dictating markup, so the same data model can render as a table on desktop and cards on mobile) and TanStack Query for client-side data fetching/caching against the Worker API.
- **Tailwind CSS**: fastest path to a genuinely mobile-first responsive table/card layout without hand-rolling breakpoints.

## 3. Data Model (D1 / SQLite DDL sketch)

```sql
CREATE TABLE providers (
  id TEXT PRIMARY KEY,                 -- 'openrouter' | 'openai' | 'anthropic' | 'google' | 'custom'
  display_name TEXT NOT NULL,
  api_key_ciphertext BLOB,             -- NULL if not connected
  api_key_last4 TEXT,                  -- for display only
  connected_at TEXT,
  last_sync_at TEXT,
  last_sync_status TEXT,               -- 'ok' | 'error' | 'never'
  last_sync_error TEXT
);

CREATE TABLE models (
  id TEXT PRIMARY KEY,                 -- internal uuid
  provider_id TEXT NOT NULL REFERENCES providers(id),
  provider_model_id TEXT NOT NULL,     -- e.g. 'claude-sonnet-4-6', 'openai/gpt-5.6'
  display_name TEXT NOT NULL,
  family TEXT,                         -- 'Claude' | 'GPT' | 'Gemini' | 'Llama' | 'Qwen' | ...
  weight_class TEXT,                   -- 'proprietary' | 'open-weights'
  size_tier TEXT,                      -- 'small' | 'medium' | 'large' | 'frontier'
  context_window_input INTEGER,
  context_window_output INTEGER,
  modalities TEXT,                     -- JSON array: ["text","image","pdf",...]
  supports_tools INTEGER DEFAULT 0,
  supports_structured_output INTEGER DEFAULT 0,
  supports_reasoning INTEGER DEFAULT 0,
  reasoning_effort_levels TEXT,        -- JSON array e.g. ["low","medium","high"] or null
  best_for_tags TEXT,                  -- JSON array of short tags
  best_for_note TEXT,                  -- free-text 1-liner
  best_for_source TEXT,                -- 'curated_default' | 'auto_suggested' | 'user_edited'
  knowledge_cutoff TEXT,
  release_date TEXT,
  deprecation_date TEXT,
  source_url TEXT,
  is_active INTEGER DEFAULT 1,         -- in user's tracked list
  is_stale INTEGER DEFAULT 0,          -- absent from most recent provider catalog
  user_overridden_fields TEXT,         -- JSON array of field names the user has manually edited
  added_at TEXT,
  last_synced_at TEXT,
  UNIQUE(provider_id, provider_model_id)
);

CREATE TABLE pricing_variants (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  variant_name TEXT NOT NULL,          -- 'standard' | 'thinking_low' | 'thinking_high' | 'batch' | ...
  input_per_1m REAL,
  output_per_1m REAL,
  cached_input_per_1m REAL,
  reasoning_output_per_1m REAL,
  unit TEXT DEFAULT 'per_1m_tokens',   -- 'per_1m_tokens' | 'per_request' | 'per_image' | 'per_second'
  notes TEXT,
  pricing_source TEXT,                 -- 'openrouter_sync' | 'manual' | 'provider_docs_curated'
  synced_at TEXT
);

CREATE TABLE sync_runs (
  id TEXT PRIMARY KEY,
  provider_id TEXT REFERENCES providers(id),
  started_at TEXT,
  finished_at TEXT,
  status TEXT,                          -- 'ok' | 'error' | 'partial'
  models_seen INTEGER,
  models_updated INTEGER,
  models_new INTEGER,
  error_message TEXT
);

CREATE TABLE pending_new_models (
  id TEXT PRIMARY KEY,
  provider_id TEXT REFERENCES providers(id),
  provider_model_id TEXT,
  raw_payload TEXT,                     -- JSON snapshot from the sync, for the "add" flow to consume
  discovered_at TEXT,
  dismissed INTEGER DEFAULT 0
);
```

Note on `user_overridden_fields`: rather than a boolean per column (which would need a schema migration every time a new trackable field is added), store a JSON array of field names the user has hand-edited. The sync job checks this array before overwriting any field and instead writes conflicting sync results to a small `field, synced_value, seen_at` side table (or simply surfaces a diff banner) rather than clobbering silently — full conflict UI is a nice-to-have; v1 can simply *skip* overwriting overridden fields and log that it skipped them.

## 4. Provider Integration Details

This is the part that shapes the whole sync design, so it's worth being explicit about what each provider's model-list API actually returns — **pricing is not uniformly available**:

| Provider | Endpoint | Auth | Returns pricing? | What it's good for |
|---|---|---|---|---|
| **OpenRouter** | `GET https://openrouter.ai/api/v1/models` (paginated via `offset`/`limit`, `limit` default up to 1000) | Public/no-auth for the catalog itself; user's own key only needed if they also want to *call* models through OpenRouter | **Yes** — `pricing.prompt` / `pricing.completion` (USD per token, as strings), plus context length, modality, supported params, quantization | Primary source of truth for pricing across ~300+ models from 55+ providers in one call; also useful for discovering open-weight models the user doesn't have a direct key for |
| **OpenAI** | `GET https://api.openai.com/v1/models` | `Authorization: Bearer <key>` (user's own OpenAI key) | No — only `id`, `object`, `created`, `owned_by` | Confirms which models a given key can actually access, canonical model IDs, availability/deprecation signal |
| **Anthropic** | `GET https://api.anthropic.com/v1/models` (paginated, `limit`/`after_id`) | `x-api-key: <key>` | No — returns id, display name, and (for newer models) capability metadata like max tokens; no cost fields | Canonical model IDs/names, capability metadata, deprecation signal |
| **Google (Gemini)** | `GET https://generativelanguage.googleapis.com/v1beta/models` (`models.list`) | `key=<api key>` query param or header | No — returns supported generation methods and token limits, no pricing | Canonical model IDs, token limits, which generation methods (e.g. `generateContent`) each model supports |

**Consequence for the sync design**: run OpenRouter sync as the pricing feed for any model that has a matching entry there (match by normalized provider + model-name heuristics, since IDs differ across catalogs — e.g. Anthropic's `claude-sonnet-4-6` vs. OpenRouter's `anthropic/claude-sonnet-4.6`). For models not present on OpenRouter (e.g., a same-day first-party release), fall back to a small curated/manual pricing table (`pricing_source = 'manual'` or `'provider_docs_curated'`) that the app owner updates by hand from each provider's published pricing page — this is unavoidable since no first-party provider exposes machine-readable pricing today. Surface `pricing_source` in the UI so the user knows whether a price is live-synced or hand-maintained and could be stale.

### Sync job flow (per provider, run on cron + on-demand)
1. Fetch catalog (paginate if needed); cache raw response in KV with a short TTL to dedupe rapid manual+scheduled triggers.
2. Normalize each entry into the internal model shape (id mapping table for cross-provider matching, see below).
3. For models already in `models` table (matched by `provider_id + provider_model_id`): update non-overridden fields, refresh `pricing_variants` from OpenRouter data if this provider is OpenRouter or a cross-reference source, set `last_synced_at`, clear `is_stale`.
4. For models in the table but absent from the fresh catalog: set `is_stale = 1` (don't delete — could be a transient API hiccup or genuine deprecation; user decides).
5. For models in the fresh catalog not yet tracked: write to `pending_new_models` (do **not** auto-add to the active list, per SPEC §6.3) for the user to review/accept in the "discover" UI.
6. Write a `sync_runs` row summarizing the run for observability/debugging.

### Cross-provider ID matching
A small normalization table/function maps provider-native IDs to a canonical family+version key (e.g., `anthropic:claude-sonnet-4-6` ↔ `openrouter:anthropic/claude-sonnet-4.6`). This is inherently a bit heuristic (string similarity + a manual alias table for known tricky cases) — ship a hand-maintained `aliases.json` seed and let sync flag low-confidence matches for manual confirmation rather than silently merging wrong models.

## 5. Worker API Surface

```
GET    /api/models                 list active models (supports ?provider=&weight_class=&search=)
GET    /api/models/:id             full detail incl. all pricing variants
POST   /api/models                 add a model manually
PATCH  /api/models/:id             edit fields (marks them user_overridden)
DELETE /api/models/:id             soft-delete (is_active=false) or ?hard=true

GET    /api/providers              list providers + connection/sync status
POST   /api/providers/:id/connect  store an API key (encrypted)
DELETE /api/providers/:id/connect  remove a stored key
POST   /api/providers/:id/sync     trigger an on-demand sync for one provider
GET    /api/providers/:id/catalog  browse the live/cached catalog to add new models from (search+paginate)

GET    /api/pending-models         list candidate new models discovered by last sync
POST   /api/pending-models/:id/accept   promote a pending model into the active list
POST   /api/pending-models/:id/dismiss

POST   /api/models/:id/suggest-best-for   trigger the "best at" auto-suggestion pipeline (§6)

GET    /api/defaults/restore       re-seed default model set (only if requested explicitly)
```

Scheduled sync is a separate Worker export (`scheduled(event, env, ctx)`), triggered by a `wrangler.toml` `[triggers] crons = ["0 6 * * *"]` entry, calling the same internal sync function the on-demand endpoint uses.

## 6. "Best At" Suggestion Pipeline

Two layers, both feeding the same editable `best_for_tags` / `best_for_note` fields:

1. **Seed data** (default model set only): hand-curated at ship time, stored in `defaults/models.json`, high trust, `best_for_source = 'curated_default'`.
2. **Auto-suggestion for newly added models**: `POST /api/models/:id/suggest-best-for` calls the Anthropic API (`/v1/messages`) with a short prompt asking for 1–3 capability tags and a one-line description, grounded by whatever structured metadata the app already has (family, size tier, context window, modalities, and, if available, a short web-search snippet about the model — the Worker can call a web-search API or simply pass known public info). The response is written back with `best_for_source = 'auto_suggested'` and surfaced in the UI as a **draft the user must confirm**, never silently treated as fact — this avoids the pipeline hallucinating capabilities. If the user edits it at all, `best_for_source` flips to `'user_edited'` and it's added to `user_overridden_fields` so future syncs never touch it.
3. This call is optional/on-demand (button per model, or a "suggest for all new models" bulk action) rather than automatic on every sync, to control cost and avoid surprising the user with unreviewed text.

## 7. Frontend Architecture

- **Framework**: React + TypeScript + Vite, deployed as a static build to Cloudflare Pages.
- **Data**: TanStack Query hooks wrapping the `/api/*` endpoints; a single `useModels()` query backs the entire table, filtering/sorting done client-side (TanStack Table) against the already-fetched list — matches the "instant filter/sort, no round trip" NFR.
- **Table/card component**: one `ModelsView` component with a single column-definition array (TanStack Table `ColumnDef[]`) shared between a `<DesktopTable>` (all columns) and `<MobileCardList>` (primary columns + expandable detail) rendered conditionally via a `useMediaQuery` breakpoint — one data/columns source of truth, two presentational shells, so mobile and desktop never drift out of sync in what data they can show.
- **State for edits**: optimistic mutation via TanStack Query `useMutation`, with the `user_overridden_fields` diff shown inline (e.g., a small "synced value differs — keep yours / take new value" affordance) rather than a separate conflicts page.
- **Styling**: Tailwind CSS, mobile-first breakpoints (`sm:`/`md:`/`lg:` prefixes added on top of a base mobile layout, not the reverse), design details per the `frontend-design` skill/system for anything visually bespoke (typography, spacing, avoiding a generic "default Tailwind" look).
- **Auth**: given this is a personal/small-group tool, a lightweight approach is enough for v1 — Cloudflare Access in front of the whole Pages project (zero app-level auth code, restricts by email/identity provider) is the recommended default; a simple shared-password/session-cookie fallback if Access isn't available in the user's Cloudflare setup.

## 8. Security

- Provider API keys: encrypted at rest in D1 using a Worker Secret (`ENCRYPTION_KEY`, set via `wrangler secret put`) with AES-GCM (Web Crypto API, available natively in Workers) before insert; decrypted only in-memory inside the Worker request handling a sync call, never returned to the client.
- Only read-only, list-style provider endpoints are ever called — no completion/generation endpoints are used, which limits both cost and blast radius if a key were ever compromised.
- CORS locked to the Pages project's own origin; API not designed for third-party consumption.
- Rate-limit on-demand sync (e.g., min interval per provider) to avoid hammering provider APIs or burning through OpenRouter's public rate limits.

## 9. Deployment

- Single repo, `wrangler.toml` defines the Pages project + Functions binding to D1 (`DB`), KV (`CATALOG_CACHE`), and the cron trigger.
- `wrangler d1 migrations` for schema management (the DDL in §3 as the initial migration).
- CI: on push to main, run typecheck/lint/tests, then `wrangler pages deploy`.
- Environments: a `preview` D1/KV binding set for PR previews (Cloudflare Pages preview deployments), `production` bindings for main.

## 10. Cost Estimate (Cloudflare)

For a single-user or small-team tool with infrequent writes and a daily cron sync of a few hundred models: comfortably within Cloudflare's free tier for Pages, Workers (well under 100k requests/day), D1 (well under free row-read/write limits), and KV — the only real recurring cost, if any, is the optional LLM call for "best at" auto-suggestions, which is small and on-demand (pay-per-call via the Anthropic API), not a fixed monthly cost.

## 11. Build Order (suggested milestones)

1. D1 schema + seed script for default model set; static table rendering (no sync yet) to validate the mobile/desktop table UX end to end.
2. Manual add/edit/remove flow (no provider integration) — validates the data model and editing UX.
3. OpenRouter sync (pricing feed) — highest value integration, no user API key required for the catalog itself.
4. OpenAI / Anthropic / Google sync (ID/capability confirmation, cross-referenced against OpenRouter pricing) + the cross-provider alias-matching logic.
5. Pending-models review queue + "discover new models" UI.
6. "Best at" auto-suggestion pipeline.
7. Cron trigger for scheduled sync + staleness indicators.
8. Auth hardening (Cloudflare Access) + key-encryption review before sharing beyond a single user.
