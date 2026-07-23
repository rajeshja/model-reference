# SPEC.md — Model Curator

## 1. Problem Statement

AI practitioners now choose between dozens of proprietary and open-weight models, released weekly, each with different pricing, context limits, and "good at" characteristics. There is no fast, personal, always-current reference that answers: *"Given my current mix of models, which one should I use for this task, and what will it cost?"*

This app is a personal (single- or few-user) **model catalog and cost/capability reference**, not a router or inference proxy. It never calls a model to generate a completion — it only tracks metadata about models.

## 2. Goals

- Give the user one scannable table of every model they care about, with cost and capability info, on both phone and desktop.
- Ship with a sensible default model list so the app is useful on first load, before the user configures anything.
- Let the user add/remove models from a live catalog (OpenRouter, OpenAI, Anthropic, Google) without hand-typing IDs or prices.
- Surface "what is this model good at" without the user having to go read four different blog posts.
- Handle models that price differently depending on a "thinking" / reasoning-effort mode (e.g., a model with standard vs. extended-thinking pricing, or discrete low/medium/high effort tiers).
- Be cheap and low-maintenance to run (Cloudflare free/low tier).

## 3. Non-Goals

- Not a chat UI, not an inference gateway, not a proxy for making completions.
- Not a benchmark suite - capability info is descriptive/curated, not independently measured.
- Not a team/enterprise tool in v1 — single-user or small-trusted-group, no granular RBAC.
- Not committing to 100% price accuracy at every instant — this is a *reference*, refreshed periodically, with a visible "last synced" timestamp. It is not a billing system.

## 4. Users

- Primary: the requester — a developer/power user running multiple AI agents (coding + non-coding) across multiple providers, who wants a fast personal decision-support tool.
- Secondary: a few collaborators sharing the same curated list.

## 5. Key Concepts / Data Model (conceptual)

**Provider** — `openrouter | openai | anthropic | google | custom`. Each provider has an optional user-supplied API key (stored server-side, encrypted at rest) used only for read-only catalog/model-list calls — never for completions.

**Model** — the core entity the whole app revolves around:
- Identity: `id` (internal), `provider`, `provider_model_id` (e.g. `claude-sonnet-4-6`, `openai/gpt-5.6`), `display_name`
- Classification: `family` (e.g. "Claude", "Gemini", "GPT", "Llama"), `weight_class` (`proprietary` / `open-weights`), `size_tier` (`small` / `medium` / `large` / `frontier`, user- or heuristically-assigned)
- Capabilities: context window (input/output max tokens), modalities (text/image/audio/video/pdf), tool-use support, structured-output support, reasoning/thinking support (bool + available effort levels)
- Cost: one or more **pricing variants** keyed by mode (see §8), each with input $/1M tokens, output $/1M tokens, and optional cached-input, batch, or long-context-tier pricing
- Curated metadata: "best for" tags/summary, short description, source links, knowledge cutoff, release date, deprecation/sunset date
- Bookkeeping: `is_active` (in user's list vs. archived), `added_at`, `last_synced_at`, `sync_source`, `is_stale` (flag if not seen in latest provider sync)

**User model list** — the set of active Models a given user has chosen to track (a join between "all discoverable models" and "my curated list"), distinct from the full catalog fetched from provider APIs.

## 6. Functional Requirements

### 6.1 Default model set
- On first run (empty database), the app seeds a configurable default list of ~15–25 well-known models spanning proprietary (Claude, GPT, Gemini) and open-weight (Llama, Qwen, DeepSeek, Mistral, etc.) families, small/medium/large tiers.
- Defaults live in a version-controlled config file (`defaults/models.json`) so the app owner can update "what ships out of the box" via a code change, independent of any live sync.
- Seeding is idempotent and only runs when the user's table is empty (or via an explicit "restore defaults" action) — it never silently overwrites user edits.

### 6.2 Add / remove models
- **Add via search**: user picks a provider, the app shows a searchable list pulled from that provider's live catalog (see §7), user selects one or more models to add to their active list.
- **Add manually**: for providers/models not covered by an integration (e.g., a niche open-weights host), user can add a model by hand: name, provider label, context window, pricing — with all capability/best-for fields optional and editable later.
- **Remove**: soft-delete by default (`is_active = false`, kept for history/undo); a "delete permanently" option purges the row. Removing a model never affects other users' lists.
- **Bulk actions**: multi-select rows in the table to remove, archive, or re-sync several models at once.

### 6.3 Provider sync
- User connects a provider by pasting an API key (OpenRouter, OpenAI, Anthropic, Google AI Studio/Gemini). Keys are stored encrypted, used only for `GET`-style catalog/list calls, never displayed again in full after entry (masked, with a "replace key" action).
- **What each integration can realistically provide** (see ARCHITECTURE.md §4 for full detail — this matters for the spec because it changes what "sync" means per provider):
  - **OpenRouter**: full catalog *including pricing* (prompt/completion $ per token, context length, modality, supported params) for 300+ models across many providers in one call. This is the primary source of ground-truth pricing for most models, including many non-OpenRouter-hosted ones by cross-reference.
  - **OpenAI**: `GET /v1/models` returns which models the key can access and basic metadata (id, created date, owner) — **not pricing**. Pricing for OpenAI models is maintained via the curated/manual pricing table (refreshed periodically from OpenAI's published pricing page) or cross-referenced from the OpenRouter catalog.
  - **Anthropic**: `GET /v1/models` returns model IDs, display names, and (for newer models) capability fields — **not pricing**. Same fallback approach as OpenAI.
  - **Google (Gemini)**: `models.list` returns model IDs, supported generation methods, and token limits — **not pricing**. Same fallback approach.
  - **Artificial Analysis** (`artificialanalysis.ai` Data API, free tier): not a pricing sync target, but the primary source for `weight_class` (explicit open-weights/proprietary/commercial-restricted classification), `size_tier` (via disclosed parameter counts and its Openness Index), and benchmark-backed capability scores (Intelligence/Coding/Math/Agentic/Multilingual indices) that feed the "best for" tags — see §6.4.
  - Net effect: OpenRouter sync is treated as the primary pricing feed *and* the primary source of a model's descriptive text; direct provider syncs are treated as the source of truth for "does this model exist / what's its exact ID / is it deprecated"; Artificial Analysis is the primary source for weight class, size tier, and benchmark-grounded capability tags. Pricing falls back to the curated table when a model isn't on OpenRouter (e.g., very new first-party releases).
- Sync is both on-demand (a "Refresh" button on the Models page, per-provider or all) and scheduled (background cron, e.g. daily) via a Cloudflare Worker Cron Trigger. Scheduled sync only *updates* existing tracked models and *flags* newly available ones for the user to review — it never silently adds new rows to the active list.
- Every model row shows a `last_synced_at` relative timestamp and a small indicator if the live catalog no longer lists it (possible deprecation).

### 6.4 "Best at" suggestions, size tier, and weight class

Two of OpenRouter's own model-list fields, plus one additional free data source, remove most of the guesswork here:

- **OpenRouter `description` field**: every model in OpenRouter's `/api/v1/models` response includes a human-written `description` — typically 1–3 sentences summarizing what the model is, and often naming what it's good at (e.g., "a reasoning model designed for speed... built for coding assistants, real-time conversational applications, and agentic workflows"). This is pulled in automatically during sync as the starting point for `best_for_note`, no separate LLM call required for models that are on OpenRouter.
- **OpenRouter `hugging_face_id` field**: present (non-empty) when the model has a corresponding Hugging Face repo - i.e., open weights available for self-hosting. This is used as the primary automatic signal for `weight_class`: present -> `open-weights`, absent -> treated as `proprietary` unless overridden. It's a good default but not infallible (some open-weight releases aren't mirrored to HF, or a provider might list a HF id for a gated/non-commercial-license model), so the field always remains user-editable.
- **Artificial Analysis free Data API** (`artificialanalysis.ai`, `GET /api/v2/data/llms/models`, free API key): a purpose-built benchmark/metadata source that directly provides:
  - An explicit **Open Weights vs. Proprietary** classification per model (and a separate "Commercial Use Restricted" flag for weight-available-but-restricted-license cases) - a stronger, purpose-built source for `weight_class` than inferring from `hugging_face_id` alone, used to cross-check/confirm it.
  - **Parameter counts** (where disclosed) and an **Openness Index** - useful for setting `size_tier` on a more principled basis than guessing from the name (e.g., a disclosed ~8B-parameter model is clearly `small`; an undisclosed frontier proprietary model showing top-of-leaderboard Intelligence Index scores is clearly `frontier`).
  - **Intelligence, Coding, Math, Agentic, and Multilingual index scores** - these map naturally onto `best_for_tags` (e.g., a model with a high Coding Index but modest Agentic Index gets tagged "strong coding, single-shot" rather than "agentic coding"), giving the auto-suggestion pipeline something benchmark-grounded to reason over instead of just a marketing description.
  - Context window, modalities, and license status, useful as a cross-check against OpenRouter's own `architecture`/`context_length` fields.
  - The free tier excludes some fields (full eval breakdown, blended pricing, percentiles) but the model-identity, openness, and index-score fields used here are available on the free tier.
- **Auto-suggestion pipeline for anything not fully covered by the above** (e.g., a brand-new model on neither OpenRouter nor Artificial Analysis yet): an on-demand LLM call, grounded in whatever structured data is available (family, size tier, context window, modalities, and any OpenRouter description or Artificial Analysis scores already fetched), proposes 1–3 capability tags and a one-line note. Auto-suggestions are always presented as **editable drafts**, never silently written as fact.
- Every field sourced this way carries a `_source` tag (`openrouter_description`, `artificial_analysis`, `auto_suggested`, `user_edited`, `curated_default`) shown in the UI, and the user can manually edit any model's best-for text, size tier, or weight class at any time regardless of source — an edit always wins over the next sync.

### 6.5 Cost display, including thinking/reasoning modes
- Some models (e.g., extended-thinking Claude, o-series/GPT reasoning effort levels, Gemini "thinking budget") price identically per token for input/output regardless of mode; others charge differently, or bill "reasoning tokens" as a distinct output-token category.
- The model detail supports **one or more named pricing variants** per model (e.g., "standard," "thinking: low/medium/high," "batch"). The table's default view shows the base/standard variant; an expandable row or detail panel shows all variants side by side.
- Every price is normalized to **$ per 1M tokens**, input and output shown separately, with cached-input pricing shown when available (many providers discount cache reads heavily — this materially affects real cost and should not be hidden).
- If a provider bills a flat per-request or per-image rate instead of per-token (rare, e.g. some image models), the app shows that as a distinct unit rather than forcing it into $/token.

### 6.6 Table / mobile-first UI
- **Single primary view**: one table, one row per model, is the whole app's core surface. No separate "dashboard," "models," and "pricing" pages competing for attention — those are just different sort/filter states of the same table.
- **Mobile-first**: on narrow viewports, the table degrades to a card-per-model stacked list (still conceptually "the table," just re-flowed), showing the highest-priority columns (name, provider, input $/output $, one capability badge) with a tap-to-expand for full detail (context window, all pricing variants, best-for text, links). On wide viewports the same data renders as a real multi-column table.
- **Columns** (desktop table / detail view on mobile): Model name & provider logo, family, weight class (proprietary/open), context window, input $/1M, output $/1M, cached-input $/1M (if any), thinking/reasoning support badge, best-for tags, last synced, status (active/stale/deprecated).
- **Sort**: by any numeric/text column (cheapest input, largest context, most recently added, etc.).
- **Filter**: provider, weight class (proprietary/open), reasoning support, modality (text/image/audio), free-text search over name/family/best-for tags.
- **Row actions**: edit, archive/remove, re-sync single model, view source links.
- No horizontal scrolling required to read the primary columns on a standard phone width (~375px); secondary columns collapse into the expanded detail view first.

### 6.7 Editing & overrides
- Every synced field is user-editable and, once user-edited, is flagged `user_overridden = true` for that field so a later sync doesn't silently clobber a manual correction (sync updates go to a separate `synced_value` alongside `display_value`; the user is shown a diff/notification when a sync would change a field they've overridden, rather than auto-applying it).

## 7. Non-Functional Requirements

- **Performance**: table with up to a few hundred models must render and filter/sort instantly client-side (no server round-trip per interaction) — data is fetched once per session/cache-bust.
- **Cost**: must run comfortably within Cloudflare's free or low-cost tiers (Workers, Pages, D1, KV) for a single/small-team user base.
- **Reliability of sync**: a failed provider sync (bad key, rate limit, provider outage) must not corrupt existing data — failures are logged and surfaced in the UI, existing rows are left untouched.
- **Security**: provider API keys stored encrypted at rest (see ARCHITECTURE.md §8), never logged, never sent to the client after initial entry, used only for outbound GET calls to each provider's model-list endpoint.
- **Offline-tolerant read**: the last-synced table data should be viewable even if a sync is currently failing or the user is offline (cache-first read).
- **Accessibility**: table/card views usable with keyboard navigation and screen readers; sufficient color contrast, no color-only status indicators.

## 8. Pricing Variant Model (detail)

Each model has ≥1 `PricingVariant`:
```
{
  variant_name: "standard" | "thinking_low" | "thinking_medium" | "thinking_high" | "batch" | custom label,
  input_per_1m: number,
  output_per_1m: number,
  cached_input_per_1m: number | null,
  reasoning_output_per_1m: number | null,   // when reasoning tokens bill separately from output
  unit: "per_1m_tokens" | "per_request" | "per_image" | "per_second",
  notes: string | null
}
```
The table's default cost columns show the `standard` variant (or the cheapest/only variant if unnamed); a model with multiple variants gets a small "+N modes" affordance leading to the detail view.

## 9. Out-of-Scope / Future Considerations

- Real-time price change alerts / diffing over time (nice-to-have v2 — the schema's `synced_value` history makes this feasible later).
- Personal usage-based cost estimator ("if I run 10k requests at this size, what's my bill") — plausible v2 feature reusing the pricing variant data.
- Team accounts with per-user permissions.
- Automated benchmark ingestion (e.g., pulling live leaderboard scores) instead of curated "best for" text.

## 10. Open Questions

- Should Google Vertex AI / AWS Bedrock / Azure OpenAI (enterprise routes with different pricing) be separate "providers" or just pricing variants on the same model? (Recommendation: separate provider entries, since IDs and pricing genuinely differ.)
- Multi-user support: shared list vs. per-user list — v1 assumption is a single shared list behind simple auth, revisit if real multi-tenant need appears.
