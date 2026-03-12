'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const path = require('path');

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function buildServiceNames() {
  const home = os.homedir();
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const hash = sha256Hex(configDir).slice(0, 8);

  // OAUTH_FILE_SUFFIX is empty in current Claude Code builds, but keep it flexible.
  const suffix = '';
  const base = `Claude Code${suffix}-credentials`;

  // If CLAUDE_CONFIG_DIR is set, Claude Code adds a hash suffix. Try both.
  const names = new Set();
  names.add(base);
  if (process.env.CLAUDE_CONFIG_DIR) names.add(`${base}-${hash}`);

  return Array.from(names);
}

function readKeychainService(service) {
  const user = process.env.USER || os.userInfo().username;
  try {
    const out = execFileSync('security', ['find-generic-password', '-a', user, '-s', service, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return out.trim();
  } catch {
    return null;
  }
}

function parseCredentialValue(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      if (parsed.accessToken) return { token: parsed.accessToken, source: 'keychain-json' };
      if (parsed.access_token) return { token: parsed.access_token, source: 'keychain-json' };
    }
  } catch {
    // fallthrough
  }
  return { token: raw, source: 'keychain-raw' };
}

function getKeychainToken() {
  const services = buildServiceNames();
  for (const svc of services) {
    const raw = readKeychainService(svc);
    const parsed = parseCredentialValue(raw);
    if (parsed && parsed.token) return { ...parsed, service: svc };
  }
  return null;
}

module.exports = {
  getKeychainToken
};
