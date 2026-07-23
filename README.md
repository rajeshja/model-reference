# AI Model Reference Application

I use AI agents for different kinds of tasks, both coding and non-coding. I like to use a mix of small and large models, both proprietary as well as open weights. However with the steady release of new "frontier" and "near-frontier" and "efficient" models every week, keeping track of which model is good for what task, and how much each model costs relative to others is virtually impossible for my human brain.

This application helps you curate and maintain a list of models, and also quickly see the cost and capabilities of each.

Here are the key features I am aiming for:
- Provide a default set of models that user can start with, configured at the application level.
- Allow users to add or remove models 
- Allow the provider and model selection, by syncing with APIs at openrouter, openai, anthropic and google
- Suggest what each model is best at, by looking up the information
- Provide the cost of the model for input and output tokens in different thinking modes if applicable
- The web page should use mobile-first design, and all the information should be provided in a single easy to navigate table.




## Cloudflare deployment notes

The browser no longer calls provider APIs directly. UI actions call same-origin `/api/*` routes implemented as Cloudflare Pages Functions in `functions/api/[[path]].js`; those functions perform provider requests server-side so provider secrets are never exposed to the client and CORS restrictions do not apply.

Configure these bindings/secrets in Cloudflare before enabling enrichment:

- `ARTIFICIAL_ANALYSIS_API_KEY` — Worker secret used by `POST /api/enrichment/sync` for the Artificial Analysis Data API.
- `MODEL_CURATOR_KV` — optional KV namespace binding used to persist the model catalog and cache the OpenRouter catalog. Without this binding, the API can still serve defaults but changes will not persist across Worker isolates.

Useful endpoints:

- `GET /api/models` lists the current curated model set.
- `POST /api/providers/openrouter/sync` fetches the OpenRouter catalog from the Worker and stores stale-status updates.
- `POST /api/enrichment/sync` fetches Artificial Analysis data from the Worker with `ARTIFICIAL_ANALYSIS_API_KEY` and enriches non-overridden model fields.
- `POST /api/defaults/restore` re-seeds the configured default model set.
