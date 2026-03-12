'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_BASE_URL = 'https://api.anthropic.com';

function readSettings() {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getBaseUrl() {
  const settings = readSettings();
  const env = settings && settings.env ? settings.env : null;
  if (env && typeof env.ANTHROPIC_BASE_URL === 'string' && env.ANTHROPIC_BASE_URL.trim()) {
    return env.ANTHROPIC_BASE_URL.trim();
  }
  return DEFAULT_BASE_URL;
}

function getEnvAuthToken({ allowPlaceholder = false } = {}) {
  const settings = readSettings();
  const env = settings && settings.env ? settings.env : null;
  const token = env && typeof env.ANTHROPIC_AUTH_TOKEN === 'string' ? env.ANTHROPIC_AUTH_TOKEN.trim() : '';
  if (!token) return null;

  const placeholders = new Set(['cloudflare', 'placeholder', 'null', 'undefined']);
  if (!allowPlaceholder && placeholders.has(token.toLowerCase())) return null;

  return token;
}

module.exports = {
  getBaseUrl,
  getEnvAuthToken,
  readSettings
};
