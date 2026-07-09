#!/usr/bin/env node

import dotenv from 'dotenv';
import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { getConfigPath, getEnvPath } from '../lib/util/paths.js';
import {
  getLlmAuthStatus,
  normalizeLlmAuth,
  runDeviceCodeLogin,
  runOAuthLogin,
} from '../lib/llm/auth.js';

dotenv.config({ path: getEnvPath() });

const args = process.argv.slice(2);
const sub = String(args[0] || 'list').toLowerCase();

function loadConfig() {
  try {
    const raw = readFileSync(getConfigPath(), 'utf8');
    return raw && raw.trim() ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

function saveConfig(config) {
  writeFileSync(getConfigPath(), JSON.stringify(config || {}, null, 2), 'utf8');
}

function modelsFromConfig(config) {
  return Array.isArray(config?.llm?.models) ? config.llm.models : [];
}

function isPriority(entry) {
  return entry && (entry.priority === true || entry.priority === 1 || String(entry.priority).toLowerCase() === 'true');
}

function modelLabel(entry, index) {
  const provider = entry?.provider || 'unknown';
  const model = entry?.model || 'local';
  return `${index + 1}. ${provider}/${model}`;
}

function findModelIndex(models, selector) {
  const raw = String(selector || '').trim();
  if (!raw) return -1;
  const asNumber = Number(raw);
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= models.length) return asNumber - 1;
  const lower = raw.toLowerCase();
  return models.findIndex((entry) => {
    const provider = String(entry?.provider || '').toLowerCase();
    const model = String(entry?.model || '').toLowerCase();
    return lower === provider || lower === model || lower === `${provider}/${model}` || lower === `${provider}:${model}`;
  });
}

function printUsage() {
  console.log('Usage: pasture llm list');
  console.log('       pasture llm use <index|provider|provider/model>');
  console.log('       pasture llm auth status');
  console.log('       pasture llm auth login <index|cache>');
}

function openBrowser(url) {
  console.log('Open this URL to finish login:');
  console.log(url);
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true });
    child.unref();
  } catch (_) {}
}

if (sub === 'list') {
  const config = loadConfig();
  const models = modelsFromConfig(config);
  if (!models.length) {
    console.log('No LLM models configured.');
    process.exit(0);
  }
  const priorityIndex = models.findIndex(isPriority);
  for (let i = 0; i < models.length; i++) {
    const entry = models[i];
    const auth = normalizeLlmAuth(entry, i);
    const status = getLlmAuthStatus(auth, entry);
    const marker = i === priorityIndex ? '*' : ' ';
    console.log(`${marker} ${modelLabel(entry, i)} auth=${status.label} configured=${status.configured ? 'yes' : 'no'}`);
  }
} else if (sub === 'use') {
  const selector = args[1];
  if (!selector) {
    printUsage();
    process.exit(1);
  }
  const config = loadConfig();
  const models = modelsFromConfig(config);
  const index = findModelIndex(models, selector);
  if (index < 0) {
    console.error('pasture: model not found:', selector);
    process.exit(1);
  }
  config.llm = config.llm || {};
  config.llm.priorityMode = 'custom';
  config.llm.models = models.map((entry, i) => {
    const next = { ...(entry || {}) };
    if (i === index) next.priority = true;
    else delete next.priority;
    return next;
  });
  saveConfig(config);
  console.log('Priority LLM set to', modelLabel(models[index], index));
} else if (sub === 'auth') {
  const authSub = String(args[1] || 'status').toLowerCase();
  const config = loadConfig();
  const models = modelsFromConfig(config);
  if (authSub === 'status') {
    if (!models.length) {
      console.log('No LLM models configured.');
      process.exit(0);
    }
    for (let i = 0; i < models.length; i++) {
      const entry = models[i];
      const auth = normalizeLlmAuth(entry, i);
      const status = getLlmAuthStatus(auth, entry);
      const expires = status.expiresAt ? ` expires=${new Date(Number(status.expiresAt)).toISOString()}` : '';
      console.log(`${modelLabel(entry, i)} auth=${status.label} configured=${status.configured ? 'yes' : 'no'}${expires}`);
    }
  } else if (authSub === 'login') {
    const selector = args[2];
    if (!selector) {
      printUsage();
      process.exit(1);
    }
    let index = findModelIndex(models, selector);
    if (index < 0) {
      index = models.findIndex((entry, i) => {
        const auth = normalizeLlmAuth(entry, i);
        return String(auth.cache || '').toLowerCase() === String(selector).toLowerCase();
      });
    }
    if (index < 0) {
      console.error('pasture: OAuth model/cache not found:', selector);
      process.exit(1);
    }
    const entry = models[index];
    const auth = normalizeLlmAuth(entry, index);
    if (auth.type !== 'oauth' && auth.type !== 'device_code') {
      console.error('pasture: selected model auth type is not oauth or device_code.');
      process.exit(1);
    }
    try {
      const result = auth.type === 'device_code'
        ? await runDeviceCodeLogin({
            auth: { ...auth, provider: entry.provider },
            openUrl: openBrowser,
          })
        : await runOAuthLogin({
            auth: { ...auth, provider: entry.provider },
            openUrl: openBrowser,
          });
      console.log('Saved LLM OAuth token cache:', result.cache);
      if (existsSync(result.path)) console.log('Token path:', result.path);
    } catch (err) {
      console.error('pasture: OAuth login failed:', err?.message || err);
      process.exit(1);
    }
  } else {
    printUsage();
    process.exit(1);
  }
} else {
  printUsage();
  process.exit(sub ? 1 : 0);
}
