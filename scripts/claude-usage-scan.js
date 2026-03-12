#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function usage() {
  console.log(`Usage: node scripts/claude-usage-scan.js <debug-log-path>

Scans a Claude Code debug log for:
- base URLs
- request URLs / endpoints
- rate limit headers
- reset timestamps
`);
}

const logPath = process.argv[2];
if (!logPath) {
  usage();
  process.exit(1);
}

if (!fs.existsSync(logPath)) {
  console.error(`Log file not found: ${logPath}`);
  process.exit(1);
}

const text = fs.readFileSync(logPath, 'utf8');
const lines = text.split(/\r?\n/);

const baseUrlCandidates = new Set();
const requestUrls = new Set();
const endpoints = new Set();
const rateLimitLines = [];
const resetLines = [];

const urlRegex = /https?:\/\/[^\s\]\)"']+/g;
const endpointRegex = /\b\/v\d+\/[^\s\]\)"']+/g;

for (const line of lines) {
  const urls = line.match(urlRegex);
  if (urls) {
    for (const u of urls) {
      requestUrls.add(u);
      try {
        const parsed = new URL(u);
        baseUrlCandidates.add(parsed.origin);
      } catch (_) {}
    }
  }

  const eps = line.match(endpointRegex);
  if (eps) {
    for (const e of eps) endpoints.add(e);
  }

  const lower = line.toLowerCase();
  if (lower.includes('x-ratelimit') || lower.includes('rate limit') || lower.includes('ratelimit')) {
    rateLimitLines.push(line);
  }
  if (lower.includes('reset') && (lower.includes('rate') || lower.includes('limit'))) {
    resetLines.push(line);
  }
}

const sorted = (set) => Array.from(set).sort();

console.log('=== Base URL Candidates ===');
console.log(sorted(baseUrlCandidates).join('\n') || '(none found)');

console.log('\n=== Request URLs (unique) ===');
console.log(sorted(requestUrls).join('\n') || '(none found)');

console.log('\n=== Endpoints (unique) ===');
console.log(sorted(endpoints).join('\n') || '(none found)');

console.log('\n=== Rate Limit Related Lines ===');
if (rateLimitLines.length === 0) console.log('(none found)');
else console.log(rateLimitLines.join('\n'));

console.log('\n=== Reset Related Lines ===');
if (resetLines.length === 0) console.log('(none found)');
else console.log(resetLines.join('\n'));
