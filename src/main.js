'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { getUsage } = require('./lib/usageClient');

let tray = null;
let win = null;
let lastUsage = null;
let refreshTimer = null;
let appSettings = { manualBudgetUsd: null };
let trayIconRef = null;
let spendHistory = [];

const REFRESH_MS = 60 * 1000;

function formatCountdown(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function usageToTitle(usage) {
  if (!usage || !usage.ok) return '…';
  const p = usage.sessionPercent ?? usage.litellmPercent ?? usage.percent ?? null;
  if (p === null || p === undefined) return '—%';
  return `${Math.round(p)}%`;
}

function usageToTooltip(usage) {
  if (!usage) return 'Claude usage';
  if (!usage.ok) return `Claude usage: ${usage.error}`;
  if (usage.mode === 'ratelimit-headers') {
    const s = usage.sessionPercent != null ? `${Math.round(usage.sessionPercent)}%` : '—%';
    const w = usage.weeklyPercent != null ? `${Math.round(usage.weeklyPercent)}%` : '—%';
    const sr = usage.sessionResetSeconds != null ? formatCountdown(usage.sessionResetSeconds) : '—';
    const wr = usage.weeklyResetSeconds != null ? formatCountdown(usage.weeklyResetSeconds) : '—';
    return `Claude usage\n5h: ${s} (reset ${sr})\n7d: ${w} (reset ${wr})`;
  }
  const remaining = usage.remaining ?? '—';
  const limit = usage.limit ?? '—';
  const reset = usage.resetSeconds != null ? formatCountdown(usage.resetSeconds) : '—';
  return `Claude usage\n${remaining}/${limit} remaining\nReset in ${reset}`;
}

function usageToLevel(usage) {
  const p = usage?.sessionPercent ?? usage?.litellmPercent ?? usage?.percent ?? null;
  if (p === null || p === undefined) return 'unknown';
  if (p < 60) return 'low';
  if (p < 85) return 'mid';
  return 'high';
}

function levelToColor(level) {
  if (level === 'low') return '#d77c58';
  if (level === 'mid') return '#d77c58';
  if (level === 'high') return '#d77c58';
  return '#d77c58';
}

function createTrayIcon(color) {
  const size = 18;
  const cx = Math.floor(size / 2);
  const cy = Math.floor(size / 2);
  const rgba = Buffer.alloc(size * size * 4, 0);

  const hex = (color || '#d77c58').replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16) || 215;
  const g = parseInt(hex.slice(2, 4), 16) || 124;
  const b = parseInt(hex.slice(4, 6), 16) || 88;

  const setPixel = (x, y, alpha = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const idx = (y * size + x) * 4;
    // Electron expects raw bitmap buffer in BGRA order.
    rgba[idx] = b;
    rgba[idx + 1] = g;
    rgba[idx + 2] = r;
    rgba[idx + 3] = alpha;
  };

  const drawDot = (x, y, radius) => {
    for (let yy = -radius; yy <= radius; yy++) {
      for (let xx = -radius; xx <= radius; xx++) {
        if (xx * xx + yy * yy <= radius * radius) setPixel(x + xx, y + yy);
      }
    }
  };

  for (let i = 0; i < 12; i++) {
    const theta = (Math.PI * 2 * i) / 12;
    const inner = 2.0;
    const outer = 7.2;
    const x0 = cx + Math.cos(theta) * inner;
    const y0 = cy + Math.sin(theta) * inner;
    const x1 = cx + Math.cos(theta) * outer;
    const y1 = cy + Math.sin(theta) * outer;
    const steps = 42;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = Math.round(x0 + (x1 - x0) * t);
      const y = Math.round(y0 + (y1 - y0) * t);
      drawDot(x, y, 2);
    }
  }

  const img = nativeImage.createFromBitmap(rgba, { width: size, height: size, scaleFactor: 2.0 });
  img.setTemplateImage(false);
  return img;
}

function applyTrayIcon(icon) {
  trayIconRef = icon;
  if (!tray) return;
  tray.setImage(trayIconRef);
  tray.setPressedImage(trayIconRef);
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function getSpendHistoryPath() {
  return path.join(app.getPath('userData'), 'spend-history.json');
}

function loadSpendHistory() {
  try {
    const raw = fs.readFileSync(getSpendHistoryPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      spendHistory = [];
      return;
    }
    spendHistory = parsed
      .filter((x) => x && Number.isFinite(Number(x.ts)) && Number.isFinite(Number(x.spend)))
      .map((x) => ({ ts: Number(x.ts), spend: Number(x.spend) }));
  } catch {
    spendHistory = [];
  }
}

function saveSpendHistory() {
  try {
    fs.mkdirSync(path.dirname(getSpendHistoryPath()), { recursive: true });
    fs.writeFileSync(getSpendHistoryPath(), JSON.stringify(spendHistory, null, 2), 'utf8');
  } catch {
    // noop
  }
}

function utcDayKey(ts) {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function labelForLocalDay(ts) {
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function attachDailyUsageSeries(usage) {
  if (!usage || !usage.ok) return usage;

  const spend = Number(usage.litellmSpend);
  const isProxy = usage.profile === 'enterprise-proxy';
  if (!isProxy || !Number.isFinite(spend)) {
    return { ...usage, dailyUsage: [] };
  }

  const now = Date.now();
  const minTs = now - 8 * 24 * 60 * 60 * 1000;
  spendHistory = spendHistory.filter((p) => Number.isFinite(p.ts) && p.ts >= minTs);
  spendHistory.push({ ts: now, spend });
  saveSpendHistory();

  const byDay = new Map();
  for (const p of spendHistory) {
    const key = utcDayKey(p.ts);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(p);
  }

  const allDays = Array.from(byDay.keys()).sort();
  const selected = allDays.slice(-4);
  const dailyUsage = selected.map((k) => {
    const points = byDay.get(k).sort((a, b) => a.ts - b.ts);
    const start = points[0]?.spend ?? 0;
    const end = points[points.length - 1]?.spend ?? start;
    const used = Math.max(0, end - start);
    return {
      day: labelForLocalDay(points[points.length - 1]?.ts ?? now),
      used
    };
  });

  return { ...usage, dailyUsage };
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(getSettingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    const budget = Number(parsed?.manualBudgetUsd);
    appSettings = {
      manualBudgetUsd: Number.isFinite(budget) && budget > 0 ? budget : null
    };
  } catch {
    appSettings = { manualBudgetUsd: null };
  }
}

function saveSettings(nextSettings) {
  const budget = Number(nextSettings?.manualBudgetUsd);
  appSettings = {
    manualBudgetUsd: Number.isFinite(budget) && budget > 0 ? budget : null
  };
  try {
    fs.mkdirSync(path.dirname(getSettingsPath()), { recursive: true });
    fs.writeFileSync(getSettingsPath(), JSON.stringify(appSettings, null, 2), 'utf8');
  } catch {
    // noop
  }
}

function applyManualBudget(usage) {
  if (!usage || !usage.ok) return usage;
  const manualBudget = appSettings?.manualBudgetUsd;
  if (!manualBudget || manualBudget <= 0) return usage;

  const spend = Number(usage.litellmSpend);
  if (!Number.isFinite(spend)) return usage;

  // Only override budget/percent when upstream does not provide one.
  if (usage.litellmBudget == null || !Number.isFinite(Number(usage.litellmBudget))) {
    const pct = Math.max(0, Math.min(100, (spend / manualBudget) * 100));
    return {
      ...usage,
      litellmBudget: manualBudget,
      litellmPercent: pct,
      budgetSource: 'manual'
    };
  }
  return usage;
}

async function refreshUsage() {
  try {
    lastUsage = attachDailyUsageSeries(applyManualBudget(await getUsage()));
    if (tray) {
      const level = usageToLevel(lastUsage);
      const color = levelToColor(level);
      const icon = createTrayIcon(color);
      applyTrayIcon(icon);
      tray.setTitle(usageToTitle(lastUsage), { fontType: 'monospacedDigit' });
      tray.setToolTip(usageToTooltip(lastUsage));
    }
    if (win) win.webContents.send('usage:update', lastUsage);
  } catch {
    lastUsage = { ok: false, error: 'refresh_failed' };
    if (tray) tray.setTitle('!');
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 348,
    height: 560,
    resizable: false,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.on('blur', () => {
    if (win && !win.webContents.isDevToolsOpened()) win.hide();
  });
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) {
    win.hide();
    return;
  }

  const trayBounds = tray.getBounds();
  const { width, height } = win.getBounds();
  const x = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
  const y = Math.round(trayBounds.y + trayBounds.height + 6);
  win.setPosition(x, y, false);
  win.show();
  win.focus();
}

function createTray() {
  const icon = createTrayIcon('#d77c58');
  tray = new Tray(icon);
  applyTrayIcon(icon);
  tray.setTitle('…', { fontType: 'monospacedDigit' });
  tray.setToolTip('Claude usage');

  tray.on('click', toggleWindow);
  tray.on('right-click', () => {
    const menu = Menu.buildFromTemplate([
      { label: 'Refresh', click: () => refreshUsage() },
      { label: 'Quit', click: () => app.quit() }
    ]);
    tray.popUpContextMenu(menu);
  });
}

app.whenReady().then(() => {
  // Keep dock visible during development so the app is discoverable on first run.
  if (process.env.NODE_ENV === 'production') {
    app.dock && app.dock.hide();
  }
  loadSettings();
  loadSpendHistory();
  createTray();
  createWindow();
  refreshUsage();
  refreshTimer = setInterval(refreshUsage, REFRESH_MS);
  // Show once on startup so users don't think the app is stuck.
  setTimeout(() => {
    if (win && !win.isVisible()) toggleWindow();
  }, 250);
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('before-quit', () => refreshTimer && clearInterval(refreshTimer));

ipcMain.handle('usage:get', async () => {
  if (!lastUsage) await refreshUsage();
  return lastUsage;
});

ipcMain.handle('usage:refresh', async () => {
  await refreshUsage();
  return lastUsage;
});

ipcMain.handle('settings:get', async () => appSettings);

ipcMain.handle('settings:save', async (_event, nextSettings) => {
  saveSettings(nextSettings);
  await refreshUsage();
  return appSettings;
});
