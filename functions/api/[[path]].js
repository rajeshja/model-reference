const STORE_KEY = 'model-curator.models.v1';

export async function onRequest(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const routeParts = Array.isArray(params.path) ? params.path : (params.path ? [params.path] : []);
  const path = `/${routeParts.join('/')}`;

  try {
    if (request.method === 'GET' && path === '/models') return json({ models: await readModels(env, request) });
    if (request.method === 'POST' && path === '/models') return json({ model: await upsertModel(env, request) }, 201);
    if (request.method === 'PATCH' && path.startsWith('/models/')) return json({ model: await upsertModel(env, request, decodeURIComponent(path.slice('/models/'.length))) });
    if (request.method === 'DELETE' && path.startsWith('/models/')) return json({ models: await deleteModel(env, request, decodeURIComponent(path.slice('/models/'.length)), url.searchParams.get('hard') === 'true') });
    if (request.method === 'POST' && path === '/defaults/restore') return json({ models: await seedDefaults(env, request, true) });
    if (request.method === 'POST' && path === '/providers/openrouter/sync') return json(await syncOpenRouter(env, request));
    if (request.method === 'POST' && path === '/enrichment/sync') return json(await syncArtificialAnalysis(env, request));
    return json({ error: 'Not found' }, 404);
  } catch (error) {
    return json({ error: error.message }, error.status || 500);
  }
}

async function readModels(env, request) {
  const stored = await getValue(env, STORE_KEY);
  if (stored) return JSON.parse(stored);
  return seedDefaults(env, request, false);
}

async function seedDefaults(env, request, force) {
  if (!force) {
    const stored = await getValue(env, STORE_KEY);
    if (stored) return JSON.parse(stored);
  }
  const defaults = await fetchDefaults(env, request);
  const now = new Date().toISOString();
  const models = defaults.map((model) => ({
    ...model,
    isActive: true,
    isStale: false,
    addedAt: now,
    lastSyncedAt: now,
    userOverriddenFields: model.userOverriddenFields || [],
  }));
  await putValue(env, STORE_KEY, JSON.stringify(models));
  return models;
}

async function fetchDefaults(env, request) {
  if (env.ASSETS) {
    const assetUrl = new URL('/defaults/models.json', request.url);
    const response = await env.ASSETS.fetch(assetUrl);
    if (response.ok) return response.json();
  }
  const response = await fetch(new URL('/defaults/models.json', request.url));
  if (!response.ok) throw Object.assign(new Error('Unable to load default models'), { status: 500 });
  return response.json();
}

async function upsertModel(env, request, id) {
  const body = await request.json();
  const models = await readModels(env, request);
  const now = new Date().toISOString();
  const model = { ...body, id: id || body.id || crypto.randomUUID(), isActive: true, lastSyncedAt: now };
  const next = models.some((item) => item.id === model.id) ? models.map((item) => (item.id === model.id ? { ...item, ...model } : item)) : [model, ...models];
  await putValue(env, STORE_KEY, JSON.stringify(next));
  return model;
}

async function deleteModel(env, request, id, hard) {
  const models = await readModels(env, request);
  const next = hard ? models.filter((model) => model.id !== id) : models.map((model) => (model.id === id ? { ...model, isActive: false } : model));
  await putValue(env, STORE_KEY, JSON.stringify(next));
  return next;
}

async function syncOpenRouter(env, request) {
  const response = await fetch('https://openrouter.ai/api/v1/models', { headers: { accept: 'application/json' } });
  if (!response.ok) throw Object.assign(new Error(`OpenRouter catalog failed: ${response.status}`), { status: 502 });
  const payload = await response.json();
  const now = new Date().toISOString();
  const catalog = (payload.data || []).map((item) => normalizeOpenRouter(item, now));
  const seen = new Set(catalog.map((model) => model.providerModelId));
  const models = (await readModels(env, request)).map((model) => model.provider === 'openrouter' ? { ...model, isStale: !seen.has(model.providerModelId), lastSyncedAt: now } : model);
  await putValue(env, STORE_KEY, JSON.stringify(models));
  await putValue(env, 'model-curator.openrouter-catalog.v1', JSON.stringify(catalog), 3600);
  return { catalog, modelsSeen: catalog.length };
}

function normalizeOpenRouter(item, now) {
  return {
    id: `or-${item.id}`.replace(/[^a-z0-9]+/gi, '-').toLowerCase(), provider: 'openrouter', providerModelId: item.id,
    displayName: item.name || item.id, family: (item.id?.split('/')[0] || 'Other').replace(/-/g, ' '),
    weightClass: item.hugging_face_id ? 'open-weights' : 'proprietary', weightClassSource: 'openrouter_hf_id',
    sizeTier: item.context_length > 500000 ? 'frontier' : item.context_length > 128000 ? 'large' : 'medium', sizeTierSource: 'openrouter_context',
    contextWindow: item.context_length || 0, maxOutputTokens: item.top_provider?.max_completion_tokens,
    modalities: item.architecture?.input_modalities || ['text'], toolUse: (item.supported_parameters || []).includes('tools'),
    structuredOutput: (item.supported_parameters || []).includes('response_format'), reasoning: (item.supported_parameters || []).includes('reasoning') || /reason|thinking|r1|o\d/i.test(item.id),
    bestForTags: tags(`${item.description || ''} ${item.id}`), bestForNote: item.description || 'Imported from OpenRouter.', sourceUrl: `https://openrouter.ai/${item.id}`,
    isActive: true, isStale: false, addedAt: now, lastSyncedAt: now, userOverriddenFields: [],
    pricingVariants: [{ variantName: 'standard', inputPer1M: Number(item.pricing?.prompt || 0) * 1e6, outputPer1M: Number(item.pricing?.completion || 0) * 1e6, cachedInputPer1M: item.pricing?.input_cache_read ? Number(item.pricing.input_cache_read) * 1e6 : null, unit: 'per_1m_tokens', notes: 'Synced from OpenRouter' }],
  };
}

async function syncArtificialAnalysis(env, request) {
  if (!env.ARTIFICIAL_ANALYSIS_API_KEY) throw Object.assign(new Error('Missing ARTIFICIAL_ANALYSIS_API_KEY Worker secret'), { status: 400 });
  const response = await fetch('https://artificialanalysis.ai/api/v2/data/llms/models', { headers: { accept: 'application/json', 'x-api-key': env.ARTIFICIAL_ANALYSIS_API_KEY } });
  if (!response.ok) throw Object.assign(new Error(`Artificial Analysis sync failed: ${response.status}`), { status: 502 });
  const payload = await response.json();
  const records = Array.isArray(payload) ? payload : (payload.data || payload.models || []);
  const now = new Date().toISOString();
  let enriched = 0;
  const models = (await readModels(env, request)).map((model) => {
    const match = records.find((record) => aaAliases(record).includes(modelKey(model)) || aaAliases(record).some((alias) => alias && modelKey(model).includes(alias)));
    if (!match) return model;
    const overridden = new Set(model.userOverriddenFields || []);
    const next = { ...model, lastSyncedAt: now };
    if (!overridden.has('weightClass')) { const weightClass = aaWeight(match); if (weightClass) Object.assign(next, { weightClass, weightClassSource: 'artificial_analysis' }); }
    if (!overridden.has('sizeTier')) Object.assign(next, { sizeTier: aaSize(match), sizeTierSource: 'artificial_analysis' });
    if (!overridden.has('bestForTags')) { const bestForTags = aaTags(match); if (bestForTags.length) Object.assign(next, { bestForTags, bestForTagsSource: 'artificial_analysis' }); }
    enriched += 1;
    return next;
  });
  await putValue(env, STORE_KEY, JSON.stringify(models));
  return { enriched, records: records.length };
}

function cleanKey(value = '') { return String(value).toLowerCase().replace(/^(models\/|openai\/|anthropic\/|google\/|meta-llama\/|mistralai\/|deepseek\/|qwen\/|x-ai\/|cohere\/|microsoft\/)/, '').replace(/[^a-z0-9]+/g, ''); }
function modelKey(model) { return cleanKey(model.providerModelId || model.displayName); }
function aaAliases(record) { return [record.name, record.slug, record.id, `${record.model_creator?.slug || ''}/${record.slug || ''}`, `${record.model_creator?.name || ''} ${record.name || ''}`].map(cleanKey).filter(Boolean); }
function aaWeight(record) { const text = JSON.stringify(record).toLowerCase(); if (/open[-_ ]weights?|open source/.test(text)) return 'open-weights'; if (/commercial[-_ ]use[-_ ]restricted|restricted/.test(text)) return 'restricted'; if (/proprietary|closed/.test(text)) return 'proprietary'; return null; }
function aaSize(record) { const params = Number(record.parameters_b || record.parameter_count_b || record.parameters?.billions || record.parameters); const intel = Number(record.evaluations?.artificial_analysis_intelligence_index || record.intelligence_index || 0); if (params) return params < 15 ? 'small' : params <= 70 ? 'medium' : params < 200 ? 'large' : 'frontier'; return intel >= 65 ? 'frontier' : intel >= 45 ? 'large' : intel >= 25 ? 'medium' : 'small'; }
function aaTags(record) { const e = record.evaluations || {}; return [['coding', e.artificial_analysis_coding_index || e.coding_index], ['math', e.artificial_analysis_math_index || e.math_index], ['agentic workflows', e.artificial_analysis_agentic_index || e.agentic_index], ['multilingual', e.artificial_analysis_multilingual_index || e.multilingual_index], ['reasoning', e.artificial_analysis_intelligence_index || e.intelligence_index]].filter(([, score]) => Number(score) > 0).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 3).map(([tag]) => tag); }
function tags(text) { const haystack = text.toLowerCase(); const found = []; if (/code|program/.test(haystack)) found.push('coding'); if (/reason|math|r1|thinking/.test(haystack)) found.push('reasoning'); if (/image|vision|multimodal/.test(haystack)) found.push('multimodal'); if (/agent/.test(haystack)) found.push('agentic workflows'); if (/open|llama|qwen|mistral|deepseek/.test(haystack)) found.push('open ecosystem'); return found.slice(0, 3); }
async function getValue(env, key) { return env.MODEL_CURATOR_KV ? env.MODEL_CURATOR_KV.get(key) : null; }
async function putValue(env, key, value, expirationTtl) { if (env.MODEL_CURATOR_KV) await env.MODEL_CURATOR_KV.put(key, value, expirationTtl ? { expirationTtl } : undefined); }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }); }
