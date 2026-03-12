let currentSettings = { manualBudgetUsd: null };
let lastHeroPct = null;

function formatCountdown(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function formatDayHourCountdown(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  const s = Math.max(0, Math.floor(seconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  return `${days}d ${hours}h`;
}

function formatAbsoluteTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatRelativeFromTs(ts) {
  if (!ts) return '—';
  return formatCountdown((ts - Date.now()) / 1000);
}

function clampPercent(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

function formatMaybeNumber(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? '—');
  return n.toFixed(digits);
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function setBar(id, pct) {
  const el = document.getElementById(id);
  if (!el) return;
  const w = pct == null ? 0 : pct;
  el.style.width = `${w}%`;
}

function renderDailyUsageChart(dailyUsage) {
  const bars = [
    document.getElementById('dayBar0'),
    document.getElementById('dayBar1'),
    document.getElementById('dayBar2'),
    document.getElementById('dayBar3')
  ];
  const labels = [
    document.getElementById('dayLabel0'),
    document.getElementById('dayLabel1'),
    document.getElementById('dayLabel2'),
    document.getElementById('dayLabel3')
  ];

  const items = Array.isArray(dailyUsage) ? dailyUsage.slice(-4) : [];
  const maxValue = items.reduce((m, x) => Math.max(m, Number(x?.used) || 0), 0);
  const chartHeight = 68;
  const floorY = 84;

  for (let i = 0; i < 4; i++) {
    const v = Number(items[i]?.used) || 0;
    const h = maxValue > 0 ? Math.max(2, Math.round((v / maxValue) * chartHeight)) : 2;
    const y = floorY - h;
    if (bars[i]) {
      bars[i].setAttribute('y', String(y));
      bars[i].setAttribute('height', String(h));
      bars[i].setAttribute('opacity', items[i] ? '1' : '0.25');
      bars[i].style.animationDelay = `${i * 70}ms`;
    }
    if (labels[i]) {
      labels[i].textContent = items[i]?.day || '—';
    }
  }
}

function animateHeroPercent(nextPct) {
  const el = document.getElementById('heroSessionPercent');
  if (!el) return;
  if (nextPct == null || !Number.isFinite(nextPct)) {
    el.textContent = '—%';
    lastHeroPct = null;
    return;
  }
  const start = Number.isFinite(lastHeroPct) ? lastHeroPct : nextPct;
  const end = nextPct;
  const duration = 420;
  const t0 = performance.now();

  const tick = (now) => {
    const p = Math.min(1, (now - t0) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    const value = start + (end - start) * eased;
    el.textContent = `${Math.round(value)}%`;
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  lastHeroPct = end;
}

function usageLevel(sessionPct) {
  if (sessionPct == null) return 'UNKNOWN';
  if (sessionPct < 60) return 'STABLE';
  if (sessionPct < 85) return 'RISING';
  return 'HOT';
}

function healthLevel(indicator) {
  const v = String(indicator || '').toLowerCase();
  if (v === 'none') return { text: 'Operational', cls: 'good' };
  if (v === 'minor') return { text: 'Minor issue', cls: 'warn' };
  if (v === 'major' || v === 'critical') return { text: 'Degraded', cls: 'bad' };
  return { text: 'Unknown', cls: 'unknown' };
}

function render(usage) {
  const isProxyProfile = true;
  const isDirectProfile = false;
  const hasNativeSessionWindow = usage?.sessionPercent != null;
  const hasNativeWeeklyWindow = usage?.weeklyPercent != null;
  const hasSessionReset = usage?.sessionResetAt != null;
  const hasWeeklyReset = usage?.weeklyResetAt != null;
  const sessionPct = clampPercent(usage?.sessionPercent ?? usage?.litellmPercent ?? usage?.percent ?? null);
  const weeklyPct = clampPercent(usage?.weeklyPercent ?? null);

  document.body.classList.toggle('profile-proxy', isProxyProfile);
  document.body.classList.toggle('profile-direct', isDirectProfile);

  renderDailyUsageChart(usage?.dailyUsage || []);

  animateHeroPercent(sessionPct);
  setText('sessionPercent', sessionPct != null ? `${Math.round(sessionPct)}%` : '—%');
  setText('weeklyPercent', weeklyPct != null ? `${Math.round(weeklyPct)}%` : '—%');
  setText('heroLabel', isProxyProfile ? 'Current (spend)' : 'Current (5h)');
  setText('sessionWindowLabel', isProxyProfile ? 'Budget usage' : '5h window');
  const healthRow = document.getElementById('healthRow');
  const healthPill = document.getElementById('healthPill');
  const health = usage?.serviceHealth || null;
  if (healthRow) healthRow.style.display = health ? 'flex' : 'none';
  if (healthPill && health) {
    const mapped = healthLevel(health.indicator);
    const codeTxt = health.claudeCodeStatus ? ` · code:${health.claudeCodeStatus}` : '';
    healthPill.textContent = `${mapped.text}${codeTxt}`;
    healthPill.classList.remove('good', 'warn', 'bad', 'unknown');
    healthPill.classList.add(mapped.cls);
  }

  setBar('sessionBar', sessionPct);
  setBar('weeklyBar', weeklyPct);

  setText('sessionReset', usage?.ok ? formatRelativeFromTs(usage?.sessionResetAt || null) : '—');
  setText('weeklyReset', usage?.ok ? formatRelativeFromTs(usage?.weeklyResetAt || null) : '—');
  setText('sessionResetAt', usage?.ok ? formatAbsoluteTime(usage?.sessionResetAt || null) : '—');
  setText('weeklyResetAt', usage?.ok ? formatAbsoluteTime(usage?.weeklyResetAt || null) : '—');

  const fallbackRem = usage?.ok ? (usage.remaining ?? usage.litellmSpend ?? '—') : '—';
  const fallbackLimit = usage?.ok ? (usage.limit ?? usage.litellmBudget ?? '—') : '—';
  const budgetResetTs = usage?.temporaryBudgetExpiry ?? null;
  const fallbackReset = usage?.ok
    ? (budgetResetTs ? formatDayHourCountdown((budgetResetTs - Date.now()) / 1000) : formatDayHourCountdown(usage?.resetSeconds))
    : '—';

  setText(
    'usageRemLimit',
    (typeof fallbackRem === 'number' || typeof fallbackLimit === 'number')
      ? `${formatMaybeNumber(fallbackRem, 3)} / ${formatMaybeNumber(fallbackLimit, 0)}`
      : `${fallbackRem} / ${fallbackLimit}`
  );
  setText('usageReset', fallbackReset);

  const mode = usage?.mode || 'unknown';
  const endpoint = usage?.endpoint || 'n/a';
  const tokenTxt = usage?.tokenUsage
    ? ` | tokens in/out=${usage.tokenUsage.inputTokens}/${usage.tokenUsage.outputTokens}`
    : '';
  const spendTxt = usage?.litellmSpend != null
    ? ` | spend=${usage.litellmSpend}${usage.litellmBudget != null ? `/${usage.litellmBudget}` : ''}${usage?.budgetSource ? `(${usage.budgetSource})` : ''}`
    : '';
  const tempTxt = usage?.temporaryBudgetIncrease != null
    ? ` | temp=+${usage.temporaryBudgetIncrease}${usage?.temporaryBudgetExpiry ? ` until ${formatAbsoluteTime(usage.temporaryBudgetExpiry)}` : ''}`
    : '';
  const statusText = usage?.ok
    ? `Endpoint: ${endpoint} (${mode}) | base=${usage?.baseUrl || 'n/a'} auth=${usage?.authSource || 'n/a'}${spendTxt}${tempTxt}${tokenTxt}`
    : `Status: ${usage?.error || 'unknown'}${usage?.detail ? ` | ${usage.detail}` : ''}`;
  const metaEl = document.getElementById('usageMeta');
  if (metaEl) {
    // Keep diagnostics hidden on success for clean UI.
    metaEl.style.display = usage?.ok ? 'none' : 'block';
    metaEl.textContent = statusText;
  }

  // Profile-based UI branching:
  // - direct-claude: clean minimal UI, hide proxy fallback cards
  // - enterprise-proxy: show spend/budget fallback cards
  const fallbackCard = document.getElementById('fallbackCard');
  if (fallbackCard) fallbackCard.style.display = isProxyProfile ? 'grid' : 'none';

  const weeklyRow = document.getElementById('weeklyRow');
  if (weeklyRow) weeklyRow.style.display = hasNativeWeeklyWindow ? 'block' : 'none';

  const weeklyResetCard = document.getElementById('weeklyResetCard');
  if (weeklyResetCard) weeklyResetCard.style.display = hasWeeklyReset ? 'flex' : 'none';

  const sessionResetCard = document.getElementById('sessionResetCard');
  if (sessionResetCard) sessionResetCard.style.display = hasSessionReset ? 'flex' : 'none';

  const trendCard = document.getElementById('trendCard');
  if (trendCard) trendCard.style.display = 'block';

  const fallbackResetMetric = document.getElementById('fallbackResetMetric');
  if (fallbackResetMetric) {
    fallbackResetMetric.style.display = isProxyProfile && (budgetResetTs || usage?.resetSeconds != null) ? 'flex' : 'none';
    const resetLabel = fallbackResetMetric.querySelector('.label');
    if (resetLabel) resetLabel.textContent = budgetResetTs ? 'Budget Reset' : 'Fallback Reset';
  }

  // Hide manual budget controls when upstream already provides a reliable budget.
  const budgetCard = document.getElementById('budgetCard');
  const budgetHint = document.getElementById('budgetHint');
  const hasUpstreamBudget = usage?.ok && Number.isFinite(Number(usage?.litellmBudget)) && usage?.budgetSource && usage?.budgetSource !== 'manual';
  if (budgetCard) budgetCard.style.display = isProxyProfile && !hasUpstreamBudget ? 'block' : 'none';
  if (budgetHint && hasUpstreamBudget) budgetHint.textContent = 'Upstream budget detected. Manual override hidden.';

  const pill = document.getElementById('statusPill');
  if (pill) {
    pill.textContent = usageLevel(sessionPct);
    const cls = sessionPct == null ? 'unknown' : sessionPct < 60 ? 'low' : sessionPct < 85 ? 'mid' : 'high';
    pill.classList.remove('low', 'mid', 'high', 'unknown');
    pill.classList.add(cls);
  }

  window.__sessionResetAt = usage?.sessionResetAt || null;
  window.__weeklyResetAt = usage?.weeklyResetAt || null;
}

function renderSettings(settings) {
  currentSettings = settings || { manualBudgetUsd: null };
  const input = document.getElementById('manualBudgetInput');
  if (input) {
    input.value = currentSettings.manualBudgetUsd != null ? String(currentSettings.manualBudgetUsd) : '';
  }
}

function startCountdownTicker() {
  const tick = () => {
    setText('sessionReset', formatRelativeFromTs(window.__sessionResetAt));
    setText('weeklyReset', formatRelativeFromTs(window.__weeklyResetAt));
  };
  setInterval(tick, 1000);
}

function initCardTilt() {
  const card = document.querySelector('.card');
  if (!card) return;

  const maxTilt = 6;
  let raf = null;

  const setTilt = (rx, ry) => {
    card.style.setProperty('--tilt-x', `${rx.toFixed(2)}deg`);
    card.style.setProperty('--tilt-y', `${ry.toFixed(2)}deg`);
  };

  const onMove = (e) => {
    const rect = card.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;
    const rotateY = (nx - 0.5) * (maxTilt * 2);
    const rotateX = (0.5 - ny) * (maxTilt * 2);

    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => setTilt(rotateX, rotateY));
  };

  const reset = () => setTilt(0, 0);

  card.addEventListener('mousemove', onMove);
  card.addEventListener('mouseleave', reset);
  card.addEventListener('blur', reset);
}

async function init() {
  const settings = await window.settingsAPI.get();
  renderSettings(settings);

  const usage = await window.usageAPI.get();
  render(usage);

  window.usageAPI.onUpdate((u) => {
    render(u);
  });

  const btn = document.getElementById('refreshBtn');
  btn.addEventListener('click', async () => {
    const u = await window.usageAPI.refresh();
    render(u);
  });

  const saveBtn = document.getElementById('saveBudgetBtn');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const input = document.getElementById('manualBudgetInput');
      const hint = document.getElementById('budgetHint');
      const n = Number(input.value);
      const manualBudgetUsd = Number.isFinite(n) && n > 0 ? n : null;
      const saved = await window.settingsAPI.save({ ...currentSettings, manualBudgetUsd });
      renderSettings(saved);
      const u = await window.usageAPI.get();
      render(u);
      if (hint) hint.textContent = manualBudgetUsd ? `Saved: $${manualBudgetUsd}` : 'Saved: disabled';
    });
  }

  startCountdownTicker();
  initCardTilt();
}

init();
