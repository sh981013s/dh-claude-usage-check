'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getBaseUrl, getEnvAuthToken } = require('./claudeConfig');
const { getKeychainToken } = require('./keychain');

const DEFAULT_ENDPOINTS = [
  '/v1/usage',
  '/v1/limits',
  '/v1/rate_limits',
  '/v1/usage/limits',
  '/usage',
  '/limits'
];

function isLocalhostUrl(url) {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(url);
}

function detectProfile({ baseUrl, hasLiteLLMHeaders, hasSelfService, hasKeyInfo }) {
  if (isLocalhostUrl(baseUrl) || hasLiteLLMHeaders || hasSelfService || hasKeyInfo) {
    return 'enterprise-proxy';
  }
  if (baseUrl === 'https://api.anthropic.com') return 'direct-claude';
  return 'unknown';
}

function getBaseUrlCandidates(configuredBaseUrl) {
  const out = [];
  if (configuredBaseUrl) out.push(configuredBaseUrl);
  if (configuredBaseUrl !== 'https://api.anthropic.com') out.push('https://api.anthropic.com');
  return out;
}

function getAuthCandidates(baseUrl) {
  const out = [];
  const keychain = getKeychainToken();
  if (keychain?.token) {
    out.push({ type: 'bearer', token: keychain.token, source: keychain.source || 'keychain' });
    out.push({ type: 'cookie', token: keychain.token, source: `${keychain.source || 'keychain'}-cookie` });
  }

  // Prefer non-placeholder env token, but keep localhost placeholder as fallback.
  const envToken = getEnvAuthToken({ allowPlaceholder: false });
  if (envToken) {
    out.push({ type: 'bearer', token: envToken, source: 'settings-env' });
    out.push({ type: 'cookie', token: envToken, source: 'settings-env-cookie' });
  }
  const envTokenLoose = getEnvAuthToken({ allowPlaceholder: true });
  if (envTokenLoose && envTokenLoose !== envToken) {
    out.push({ type: 'bearer', token: envTokenLoose, source: 'settings-env-loose' });
    out.push({ type: 'cookie', token: envTokenLoose, source: 'settings-env-loose-cookie' });
  }

  if (isLocalhostUrl(baseUrl)) out.push({ type: 'none', token: null, source: 'no-auth-localhost' });
  return out;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

function parseDebugHeaderValue(text, name) {
  const re = new RegExp(`${name}\\s*[:=]\\s*([0-9.]+)`, 'i');
  const m = text.match(re);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function parseUsageFromClaudeDebugLog(text) {
  if (!text) return null;
  const sessionUtil = parseDebugHeaderValue(text, 'anthropic-ratelimit-unified-5h-utilization');
  const weeklyUtil = parseDebugHeaderValue(text, 'anthropic-ratelimit-unified-7d-utilization');
  const sessionReset = parseDebugHeaderValue(text, 'anthropic-ratelimit-unified-5h-reset');
  const weeklyReset = parseDebugHeaderValue(text, 'anthropic-ratelimit-unified-7d-reset');

  if (sessionUtil == null && weeklyUtil == null) return null;

  return {
    sessionPercent: sessionUtil != null ? Math.max(0, Math.min(100, sessionUtil * 100)) : null,
    weeklyPercent: weeklyUtil != null ? Math.max(0, Math.min(100, weeklyUtil * 100)) : null,
    sessionResetAt: sessionReset != null ? sessionReset * 1000 : null,
    weeklyResetAt: weeklyReset != null ? weeklyReset * 1000 : null
  };
}

async function fetchUsageFromClaudeCliDebug() {
  const debugPath = path.join(os.tmpdir(), `calcal-claude-debug-${Date.now()}.log`);
  try {
    execFileSync(
      'claude',
      ['-p', 'ping', '--debug', 'api', '--debug-file', debugPath],
      { stdio: ['ignore', 'ignore', 'ignore'], timeout: 20000 }
    );
  } catch {
    // Some invocations may still generate debug output even on non-zero exit.
  }

  try {
    if (!fs.existsSync(debugPath)) return { ok: false, reason: 'cli_debug_not_created' };
    const raw = fs.readFileSync(debugPath, 'utf8');
    const parsed = parseUsageFromClaudeDebugLog(raw);
    if (!parsed) return { ok: false, reason: 'cli_headers_not_found' };
    return { ok: true, parsed };
  } catch {
    return { ok: false, reason: 'cli_debug_read_failed' };
  } finally {
    try {
      fs.unlinkSync(debugPath);
    } catch {
      // noop
    }
  }
}

async function fetchClaudeServiceHealth() {
  const base = 'https://status.anthropic.com/api/v2';
  try {
    const [statusRes, summaryRes] = await Promise.all([
      fetchWithTimeout(`${base}/status.json`, { method: 'GET' }, 3500),
      fetchWithTimeout(`${base}/summary.json`, { method: 'GET' }, 3500)
    ]);
    if (!statusRes.ok) return { ok: false, reason: `status_http_${statusRes.status}` };

    const statusBody = await statusRes.json();
    let summaryBody = null;
    if (summaryRes.ok) {
      try {
        summaryBody = await summaryRes.json();
      } catch {
        summaryBody = null;
      }
    }

    const indicator = String(statusBody?.status?.indicator || '').toLowerCase();
    const description = statusBody?.status?.description || 'Unknown';
    const components = Array.isArray(summaryBody?.components) ? summaryBody.components : [];
    const codeComponent = components.find((c) => String(c?.name || '').toLowerCase().includes('claude code')) || null;

    return {
      ok: true,
      indicator: indicator || 'none',
      description,
      pageUpdatedAt: statusBody?.page?.updated_at || null,
      claudeCodeStatus: codeComponent?.status || null
    };
  } catch (error) {
    return { ok: false, reason: error?.name || 'health_fetch_error' };
  }
}

function parseUnifiedRateLimitHeaders(headers) {
  const get = (name) => {
    const v = headers.get(name);
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const sessionUtil = get('anthropic-ratelimit-unified-5h-utilization');
  const sessionReset = get('anthropic-ratelimit-unified-5h-reset');
  const weeklyUtil = get('anthropic-ratelimit-unified-7d-utilization');
  const weeklyReset = get('anthropic-ratelimit-unified-7d-reset');

  if (sessionUtil === null && weeklyUtil === null) return null;

  return {
    sessionPercent: sessionUtil !== null ? Math.max(0, sessionUtil * 100) : null,
    weeklyPercent: weeklyUtil !== null ? Math.max(0, weeklyUtil * 100) : null,
    sessionReset: sessionReset ? sessionReset * 1000 : null,
    weeklyReset: weeklyReset ? weeklyReset * 1000 : null
  };
}

function parseAnyRateHeaders(headers) {
  const all = {};
  for (const [k, v] of headers.entries()) all[k.toLowerCase()] = v;

  const pick = (...keys) => {
    for (const k of keys) {
      if (all[k] !== undefined) return all[k];
    }
    return null;
  };

  const sessionUtil = pick(
    'anthropic-ratelimit-unified-5h-utilization',
    'anthropic-ratelimit-5h-utilization',
    'x-ratelimit-5h-utilization',
    'x-ratelimit-session-utilization'
  );
  const sessionReset = pick(
    'anthropic-ratelimit-unified-5h-reset',
    'anthropic-ratelimit-5h-reset',
    'x-ratelimit-5h-reset',
    'x-ratelimit-session-reset'
  );
  const weeklyUtil = pick(
    'anthropic-ratelimit-unified-7d-utilization',
    'anthropic-ratelimit-7d-utilization',
    'x-ratelimit-7d-utilization',
    'x-ratelimit-weekly-utilization'
  );
  const weeklyReset = pick(
    'anthropic-ratelimit-unified-7d-reset',
    'anthropic-ratelimit-7d-reset',
    'x-ratelimit-7d-reset',
    'x-ratelimit-weekly-reset'
  );

  const toNum = (v) => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const su = toNum(sessionUtil);
  const sr = toNum(sessionReset);
  const wu = toNum(weeklyUtil);
  const wr = toNum(weeklyReset);

  // Support either [0,1] utilization or already-percent values.
  const toPct = (n) => {
    if (n === null) return null;
    if (n <= 1) return Math.max(0, Math.min(100, n * 100));
    return Math.max(0, Math.min(100, n));
  };

  if (su === null && wu === null && sr === null && wr === null) return null;

  const asMs = (n) => {
    if (n === null || !Number.isFinite(n) || n <= 0) return null;
    return n > 1e12 ? n : n * 1000;
  };

  return {
    sessionPercent: toPct(su),
    weeklyPercent: toPct(wu),
    sessionReset: asMs(sr),
    weeklyReset: asMs(wr),
    raw: all
  };
}

function parseLiteLLMHeaders(headers) {
  const getNum = (name) => {
    const v = headers.get(name);
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const keySpend = getNum('x-litellm-key-spend');
  const reqCost =
    getNum('x-litellm-response-cost-original') ??
    getNum('x-litellm-response-cost-margin-amount') ??
    null;
  const model = headers.get('x-litellm-model-id') || null;

  if (keySpend === null && reqCost === null) return null;
  return { keySpend, reqCost, model };
}

function parseRateLimitHeaders(headers) {
  const lower = {};
  for (const [k, v] of headers.entries()) lower[k.toLowerCase()] = v;

  const remaining = lower['x-ratelimit-remaining'] || lower['x-ratelimit-remaining-requests'];
  const limit = lower['x-ratelimit-limit'] || lower['x-ratelimit-limit-requests'];
  const reset = lower['x-ratelimit-reset'] || lower['x-ratelimit-reset-requests'];

  if (!remaining && !limit && !reset) return null;

  return {
    remaining: remaining ? Number(remaining) : null,
    limit: limit ? Number(limit) : null,
    reset: reset ? Number(reset) : null,
    raw: lower
  };
}

function normalizeUsageFromBody(body) {
  if (!body || typeof body !== 'object') return null;

  // Heuristic parsing. Adjust once we know the exact schema.
  const remaining = body.remaining ?? body.remaining_tokens ?? body.remainingRequests ?? null;
  const limit = body.limit ?? body.limit_tokens ?? body.limitRequests ?? null;
  const reset = body.reset ?? body.reset_at ?? body.resetAt ?? null;
  const window = body.window ?? body.window_seconds ?? body.windowSeconds ?? null;

  if (remaining === null && limit === null && reset === null) return null;

  return {
    remaining: remaining !== null ? Number(remaining) : null,
    limit: limit !== null ? Number(limit) : null,
    reset: reset || null,
    window: window !== null ? Number(window) : null,
    raw: body
  };
}

function buildAuthHeaders(auth) {
  const headers = { 'Content-Type': 'application/json' };
  if (!auth || auth.type === 'none') return headers;
  if (auth.type === 'bearer' && auth.token) headers.Authorization = `Bearer ${auth.token}`;
  if (auth.type === 'cookie' && auth.token) headers.Cookie = `sessionKey=${auth.token}`;
  return headers;
}

function toPercentFromUnknownScale(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 1) return Math.max(0, Math.min(100, n * 100));
  return Math.max(0, Math.min(100, n));
}

function parseClaudeAiUsageBody(body) {
  if (!body || typeof body !== 'object') return null;
  const five = body.five_hour || body.fiveHour || null;
  const seven = body.seven_day || body.sevenDay || null;
  if (!five && !seven) return null;

  const sessionPercent = five ? toPercentFromUnknownScale(five.utilization ?? five.percent ?? five.usage ?? null) : null;
  const weeklyPercent = seven ? toPercentFromUnknownScale(seven.utilization ?? seven.percent ?? seven.usage ?? null) : null;

  const parseReset = (v) => {
    if (!v) return null;
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
    return null;
  };

  const sessionResetAt = five ? parseReset(five.resets_at ?? five.reset ?? five.reset_at ?? null) : null;
  const weeklyResetAt = seven ? parseReset(seven.resets_at ?? seven.reset ?? seven.reset_at ?? null) : null;

  if (sessionPercent == null && weeklyPercent == null) return null;
  return { sessionPercent, weeklyPercent, sessionResetAt, weeklyResetAt };
}

function collectResetCandidate(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return t;
    const n = Number(value);
    if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000;
    return null;
  }
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  return null;
}

function parseUsageFromGenericBody(body) {
  if (!body || typeof body !== 'object') return null;

  const direct = parseClaudeAiUsageBody(body);
  if (direct) return direct;

  // Known alternates that proxies sometimes use.
  const five = body['5h'] || body.five_hour || body.fiveHour || body.session || null;
  const seven = body['7d'] || body.seven_day || body.sevenDay || body.weekly || null;

  const toPct = (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    return toPercentFromUnknownScale(
      obj.utilization ?? obj.usage ?? obj.percentage ?? obj.percent ?? obj.used_pct ?? null
    );
  };
  const toReset = (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    return collectResetCandidate(obj.reset ?? obj.reset_at ?? obj.resets_at ?? obj.resetAt ?? null);
  };

  const sessionPercent = toPct(five);
  const weeklyPercent = toPct(seven);
  const sessionResetAt = toReset(five);
  const weeklyResetAt = toReset(seven);

  if (sessionPercent == null && weeklyPercent == null && sessionResetAt == null && weeklyResetAt == null) return null;
  return { sessionPercent, weeklyPercent, sessionResetAt, weeklyResetAt };
}

async function probeEndpoints({ baseUrl, auth, endpoints = DEFAULT_ENDPOINTS }) {
  for (const ep of endpoints) {
    const url = new URL(ep, baseUrl).toString();
    try {
      const res = await fetchWithTimeout(url, {
        method: 'GET',
        headers: buildAuthHeaders(auth)
      });

      const headerUsage = parseRateLimitHeaders(res.headers);
      let bodyUsage = null;
      let body = null;

      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        body = await res.json();
        bodyUsage = normalizeUsageFromBody(body);
      }

      if (headerUsage || bodyUsage) {
        return {
          endpoint: ep,
          url,
          status: res.status,
          headerUsage,
          bodyUsage,
          body
        };
      }
    } catch {
      // Try next endpoint
    }
  }

  return null;
}

async function fetchUsageFromMessagesAPI({ baseUrl, auth }) {
  const url = new URL('/v1/messages', baseUrl).toString();

  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }]
  };

  try {
    const headers = buildAuthHeaders(auth);
    headers['anthropic-version'] = '2023-06-01';
    if (auth?.type === 'bearer' && auth?.token) {
      headers['anthropic-beta'] = 'oauth-2025-04-20';
    }

    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    }, 8000);

    if (!res.ok && res.status !== 429 && res.status !== 403) {
      return { ok: false, status: res.status, reason: 'http_status_not_supported' };
    }

    const unified = parseUnifiedRateLimitHeaders(res.headers);
    const anyRate = parseAnyRateHeaders(res.headers);
    const classic = parseRateLimitHeaders(res.headers);
    const litellm = parseLiteLLMHeaders(res.headers);

    // If no rate-limit headers are present, try body-based extraction for proxy variants.
    let bodyParsed = null;
    let bodyPreview = '';
    const ct = res.headers.get('content-type') || '';
    if (!unified && !anyRate && !classic && ct.includes('application/json')) {
      const body = await res.json();
      bodyParsed = parseUsageFromGenericBody(body);
      bodyPreview = JSON.stringify(body).slice(0, 240);
    } else if (!unified && !anyRate && !classic) {
      bodyPreview = (await res.text()).slice(0, 240);
    }

    if (!unified && !anyRate && !classic && !bodyParsed && !litellm) {
      const headerKeys = Array.from(res.headers.keys()).slice(0, 24).join(',');
      return {
        ok: false,
        status: res.status,
        reason: 'missing_ratelimit_headers',
        detail: `headers=[${headerKeys}] body=${bodyPreview}`
      };
    }

    const parsed = bodyParsed || unified || anyRate || {
      sessionPercent: classic && classic.limit && classic.remaining != null
        ? Math.max(0, Math.min(100, ((classic.limit - classic.remaining) / classic.limit) * 100))
        : null,
      weeklyPercent: null,
      sessionReset: classic ? (Number(classic.reset) > 1e12 ? Number(classic.reset) : Number(classic.reset) * 1000) : null,
      weeklyReset: null
    };

    let tokenUsage = null;
    if (!bodyParsed && !unified && !anyRate && !classic) {
      try {
        const ct2 = res.headers.get('content-type') || '';
        if (ct2.includes('application/json')) {
          const body = await res.clone().json();
          if (body?.usage && typeof body.usage === 'object') {
            tokenUsage = {
              inputTokens: Number(body.usage.input_tokens ?? 0) || 0,
              outputTokens: Number(body.usage.output_tokens ?? 0) || 0,
              cacheCreationTokens: Number(body.usage.cache_creation_input_tokens ?? 0) || 0,
              cacheReadTokens: Number(body.usage.cache_read_input_tokens ?? 0) || 0
            };
          }
        }
      } catch {
        // ignore
      }
    }

    return {
      ok: true,
      endpoint: '/v1/messages',
      url,
      status: res.status,
      unified: parsed,
      litellm,
      tokenUsage
    };
  } catch (error) {
    return { ok: false, reason: error?.name || 'fetch_error', detail: String(error?.message || error) };
  }
}

async function fetchLiteLLMKeyInfo({ baseUrl, auth }) {
  const paths = ['/key/info', '/v1/key/info', '/api/key/info'];
  for (const p of paths) {
    const url = new URL(p, baseUrl).toString();
    try {
      const res = await fetchWithTimeout(url, {
        method: 'GET',
        headers: buildAuthHeaders(auth)
      }, 5000);
      if (!res.ok) continue;
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) continue;
      const body = await res.json();
      const spend = Number(body?.spend ?? body?.key_spend ?? body?.data?.spend);
      const maxBudget = Number(body?.max_budget ?? body?.maxBudget ?? body?.data?.max_budget);
      if (!Number.isFinite(spend) && !Number.isFinite(maxBudget)) continue;
      return {
        ok: true,
        endpoint: p,
        spend: Number.isFinite(spend) ? spend : null,
        maxBudget: Number.isFinite(maxBudget) ? maxBudget : null
      };
    } catch {
      // continue
    }
  }
  return { ok: false };
}

async function fetchSelfServiceBudget({ baseUrl, auth }) {
  const paths = [
    '/dh-self-service/api/v1/self',
    '/api/v1/self',
    '/self'
  ];

  for (const p of paths) {
    const url = new URL(p, baseUrl).toString();
    try {
      const res = await fetchWithTimeout(url, {
        method: 'GET',
        headers: buildAuthHeaders(auth)
      }, 5000);
      if (!res.ok) continue;
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) continue;
      const body = await res.json();

      const spend = Number(body?.spend);
      const maxBudget = Number(body?.max_budget);
      const tempIncrease = Number(body?.temporary_budget?.increase);
      const tempExpiryRaw = body?.temporary_budget?.expiry || null;
      const tempExpiry = tempExpiryRaw ? Date.parse(tempExpiryRaw) : null;
      const tempActive = Number.isFinite(tempExpiry) ? tempExpiry > Date.now() : false;

      if (!Number.isFinite(spend) && !Number.isFinite(maxBudget)) continue;

      const effectiveBudget = (Number.isFinite(maxBudget) ? maxBudget : 0)
        + (tempActive && Number.isFinite(tempIncrease) ? tempIncrease : 0);

      return {
        ok: true,
        endpoint: p,
        spend: Number.isFinite(spend) ? spend : null,
        maxBudget: Number.isFinite(maxBudget) ? maxBudget : null,
        temporaryIncrease: tempActive && Number.isFinite(tempIncrease) ? tempIncrease : null,
        temporaryExpiry: tempActive ? tempExpiry : null,
        effectiveBudget: effectiveBudget > 0 ? effectiveBudget : null
      };
    } catch {
      // try next path
    }
  }

  return { ok: false };
}

async function fetchOrganizations({ baseUrl, auth }) {
  const paths = ['/api/organizations', '/organizations', '/api/oauth/organizations'];
  for (const p of paths) {
    const url = new URL(p, baseUrl).toString();
    try {
      const res = await fetchWithTimeout(url, { method: 'GET', headers: buildAuthHeaders(auth) }, 6000);
      if (!res.ok) continue;
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) continue;
      const body = await res.json();
      const arr = Array.isArray(body) ? body : body?.organizations || body?.data || null;
      if (!Array.isArray(arr) || !arr.length) continue;
      const ids = arr
        .map((o) => o?.uuid || o?.id || o?.organization_id || null)
        .filter(Boolean)
        .map((v) => String(v));
      if (ids.length) return { ok: true, ids };
    } catch {
      // continue
    }
  }
  return { ok: false, reason: 'org_http_error' };
}

async function fetchUsageFromClaudeAiEndpoint({ baseUrl, auth }) {
  const orgs = await fetchOrganizations({ baseUrl, auth });
  if (!orgs.ok) return { ok: false, reason: `org_lookup:${orgs.reason || 'failed'}`, status: orgs.status };

  const usagePaths = (orgId) => [
    `/api/organizations/${orgId}/usage`,
    `/organizations/${orgId}/usage`,
    `/api/organizations/${orgId}/limits`,
    `/organizations/${orgId}/limits`
  ];

  for (const orgId of orgs.ids.slice(0, 3)) {
    for (const p of usagePaths(orgId)) {
      const url = new URL(p, baseUrl).toString();
      try {
        const res = await fetchWithTimeout(url, { method: 'GET', headers: buildAuthHeaders(auth) }, 7000);
        if (!res.ok) continue;
        const ct = res.headers.get('content-type') || '';
        if (!ct.includes('application/json')) continue;
        const body = await res.json();
        const parsed = parseUsageFromGenericBody(body);
        if (!parsed) continue;
        return { ok: true, endpoint: p, parsed };
      } catch {
        // try next endpoint
      }
    }
  }
  return { ok: false, reason: 'claudeai_usage_unparsed' };
}

function toPercent(remaining, limit) {
  if (typeof remaining !== 'number' || typeof limit !== 'number' || limit <= 0) return null;
  const used = Math.max(0, limit - remaining);
  return Math.round((used / limit) * 100);
}

function computeResetCountdown(reset) {
  if (!reset) return null;
  const resetMs = typeof reset === 'number' ? reset * 1000 : Date.parse(reset);
  if (Number.isNaN(resetMs)) return null;
  const diffMs = resetMs - Date.now();
  return Math.max(0, Math.floor(diffMs / 1000));
}

async function getUsage() {
  const configuredBaseUrl = getBaseUrl();
  const baseCandidates = getBaseUrlCandidates(configuredBaseUrl);
  const diagnostics = [];

  for (const baseUrl of baseCandidates) {
    const authCandidates = getAuthCandidates(baseUrl);
    if (!authCandidates.length) {
      if (baseUrl === 'https://api.anthropic.com') {
        const cliUsage = await fetchUsageFromClaudeCliDebug();
        if (cliUsage.ok) {
          const sessionResetSeconds = cliUsage.parsed.sessionResetAt
            ? Math.max(0, Math.floor((cliUsage.parsed.sessionResetAt - Date.now()) / 1000))
            : null;
          const weeklyResetSeconds = cliUsage.parsed.weeklyResetAt
            ? Math.max(0, Math.floor((cliUsage.parsed.weeklyResetAt - Date.now()) / 1000))
            : null;
          return {
            ok: true,
            profile: 'direct-claude',
            baseUrl,
            authSource: 'claude-cli-session',
            endpoint: '/v1/messages',
            mode: 'cli-debug-headers',
            sessionPercent: cliUsage.parsed.sessionPercent,
            weeklyPercent: cliUsage.parsed.weeklyPercent,
            sessionResetAt: cliUsage.parsed.sessionResetAt,
            weeklyResetAt: cliUsage.parsed.weeklyResetAt,
            sessionResetSeconds,
            weeklyResetSeconds,
            serviceHealth: await fetchClaudeServiceHealth()
          };
        }
        diagnostics.push(`base=${baseUrl}: no-auth-candidate cli=${cliUsage.reason}`);
      }
      diagnostics.push(`base=${baseUrl}: no-auth-candidate`);
      continue;
    }

    for (const auth of authCandidates) {
      const headersUsage = await fetchUsageFromMessagesAPI({ baseUrl, auth });
      if (headersUsage.ok) {
        const selfBudget = await fetchSelfServiceBudget({ baseUrl, auth });
        const litellmKeyInfo = await fetchLiteLLMKeyInfo({ baseUrl, auth });
        const profile = detectProfile({
          baseUrl,
          hasLiteLLMHeaders: Boolean(headersUsage?.litellm),
          hasSelfService: selfBudget.ok,
          hasKeyInfo: litellmKeyInfo.ok
        });
        let litellmPercent = null;
        let litellmSpend = headersUsage?.litellm?.keySpend ?? null;
        let litellmBudget = null;
        let budgetSource = null;

        if (selfBudget.ok) {
          litellmSpend = selfBudget.spend ?? litellmSpend;
          litellmBudget = selfBudget.effectiveBudget ?? selfBudget.maxBudget ?? litellmBudget;
          budgetSource = 'self-service';
          if (Number.isFinite(litellmSpend) && Number.isFinite(litellmBudget) && litellmBudget > 0) {
            litellmPercent = Math.max(0, Math.min(100, (litellmSpend / litellmBudget) * 100));
          }
        }

        if (litellmKeyInfo.ok) {
          litellmSpend = litellmSpend ?? litellmKeyInfo.spend;
          litellmBudget = litellmBudget ?? litellmKeyInfo.maxBudget;
          budgetSource = budgetSource || 'key-info';
          if (Number.isFinite(litellmSpend) && Number.isFinite(litellmBudget) && litellmBudget > 0) {
            litellmPercent = Math.max(0, Math.min(100, (litellmSpend / litellmBudget) * 100));
          }
        }

        const sessionResetSeconds = headersUsage.unified.sessionReset
          ? Math.max(0, Math.floor((headersUsage.unified.sessionReset - Date.now()) / 1000))
          : null;
        const weeklyResetSeconds = headersUsage.unified.weeklyReset
          ? Math.max(0, Math.floor((headersUsage.unified.weeklyReset - Date.now()) / 1000))
          : null;

        return {
          ok: true,
          profile,
          baseUrl,
          authSource: auth.source,
          endpoint: headersUsage.endpoint,
          mode: 'ratelimit-headers',
          sessionPercent: headersUsage.unified.sessionPercent,
          weeklyPercent: headersUsage.unified.weeklyPercent,
          sessionResetAt: headersUsage.unified.sessionReset,
          weeklyResetAt: headersUsage.unified.weeklyReset,
          sessionResetSeconds,
          weeklyResetSeconds,
          litellmSpend,
          litellmBudget,
          litellmPercent,
          budgetSource,
          temporaryBudgetIncrease: selfBudget.ok ? selfBudget.temporaryIncrease : null,
          temporaryBudgetExpiry: selfBudget.ok ? selfBudget.temporaryExpiry : null,
          requestCost: headersUsage?.litellm?.reqCost ?? null,
          modelId: headersUsage?.litellm?.model ?? null,
          tokenUsage: headersUsage?.tokenUsage ?? null,
          serviceHealth: await fetchClaudeServiceHealth()
        };
      }

      diagnostics.push(
        `base=${baseUrl} auth=${auth.source}/${auth.type} messages=${headersUsage.reason}${headersUsage.status ? `(${headersUsage.status})` : ''}${headersUsage.detail ? `:${headersUsage.detail}` : ''}`
      );

      const claudeAiUsage = await fetchUsageFromClaudeAiEndpoint({ baseUrl, auth });
      if (claudeAiUsage.ok) {
        const profile = detectProfile({
          baseUrl,
          hasLiteLLMHeaders: false,
          hasSelfService: false,
          hasKeyInfo: false
        });
        const sessionResetSeconds = claudeAiUsage.parsed.sessionResetAt
          ? Math.max(0, Math.floor((claudeAiUsage.parsed.sessionResetAt - Date.now()) / 1000))
          : null;
        const weeklyResetSeconds = claudeAiUsage.parsed.weeklyResetAt
          ? Math.max(0, Math.floor((claudeAiUsage.parsed.weeklyResetAt - Date.now()) / 1000))
          : null;
        return {
          ok: true,
          profile,
          baseUrl,
          authSource: auth.source,
          endpoint: claudeAiUsage.endpoint,
          mode: 'claudeai-usage-endpoint',
          sessionPercent: claudeAiUsage.parsed.sessionPercent,
          weeklyPercent: claudeAiUsage.parsed.weeklyPercent,
          sessionResetAt: claudeAiUsage.parsed.sessionResetAt,
          weeklyResetAt: claudeAiUsage.parsed.weeklyResetAt,
          sessionResetSeconds,
          weeklyResetSeconds,
          serviceHealth: await fetchClaudeServiceHealth()
        };
      }

      diagnostics.push(`base=${baseUrl} auth=${auth.source}/${auth.type} claudeai=${claudeAiUsage.reason}`);

      const probed = await probeEndpoints({ baseUrl, auth });
      if (probed) {
        const profile = detectProfile({
          baseUrl,
          hasLiteLLMHeaders: false,
          hasSelfService: false,
          hasKeyInfo: false
        });
        const usage = probed.bodyUsage || probed.headerUsage;
        const percent = usage ? toPercent(usage.remaining, usage.limit) : null;
        const resetSeconds = usage ? computeResetCountdown(usage.reset) : null;

        return {
          ok: true,
          profile,
          baseUrl,
          authSource: auth.source,
          endpoint: probed.endpoint,
          mode: 'endpoint-probe',
          percent,
          remaining: usage.remaining ?? null,
          limit: usage.limit ?? null,
          reset: usage.reset ?? null,
          resetSeconds,
          raw: usage.raw,
          serviceHealth: await fetchClaudeServiceHealth()
        };
      }

      diagnostics.push(`base=${baseUrl} auth=${auth.source}/${auth.type} probe=no_match`);
    }
  }

  return {
    ok: false,
    error: 'no_usage_endpoint',
    profile: detectProfile({
      baseUrl: configuredBaseUrl || '',
      hasLiteLLMHeaders: false,
      hasSelfService: false,
      hasKeyInfo: false
    }),
    baseUrl: configuredBaseUrl,
    detail: diagnostics.slice(0, 8).join(' | ')
  };
}

module.exports = {
  getUsage
};
