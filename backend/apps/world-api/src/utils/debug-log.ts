import fs from 'fs';
import path from 'path';

const DEFAULT_LOG_FILE = path.join(process.cwd(), 'logs', 'soulbyte-debug.log');
const DEBUG_LOG_FILE = process.env.CONSOLE_LOG_DEBUG_FILE
  ? path.resolve(process.env.CONSOLE_LOG_DEBUG_FILE)
  : DEFAULT_LOG_FILE;
const OPENCLAW_LOG_FILE = process.env.OPENCLAW_DEBUG_LOG_FILE
  ? path.resolve(process.env.OPENCLAW_DEBUG_LOG_FILE)
  : path.join(process.cwd(), 'logs', 'openclaw-debug.log');

let ensured = false;
let ensuredOpenclaw = false;

function ensureLogDir(filePath: string, flag: 'default' | 'openclaw') {
  if (flag === 'openclaw' ? ensuredOpenclaw : ensured) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (flag === 'openclaw') {
    ensuredOpenclaw = true;
  } else {
    ensured = true;
  }
}

function isTruthyFlag(value: string | undefined | null): boolean {
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

function isOpenclawScope(scope: string): boolean {
  return scope.startsWith('openclaw.');
}

export function isDebugEnabled(scope?: string): boolean {
  if (scope && isOpenclawScope(scope)) {
    return isTruthyFlag(process.env.OPENCLAW_DEBUG);
  }
  return isTruthyFlag(process.env.CONSOLE_LOG_DEBUG);
}

export function debugLog(scope: string, payload: unknown) {
  if (!isDebugEnabled(scope)) return;
  const isOpenclaw = isOpenclawScope(scope);
  const targetFile = isOpenclaw ? OPENCLAW_LOG_FILE : DEBUG_LOG_FILE;
  ensureLogDir(targetFile, isOpenclaw ? 'openclaw' : 'default');
  const entry = {
    ts: new Date().toISOString(),
    scope,
    payload,
  };
  const line = JSON.stringify(entry);
  fs.appendFile(targetFile, `${line}\n`, () => {});
  console.log(`[DEBUG:${scope}] ${line}`);
}

export function getDebugLogPath() {
  return DEBUG_LOG_FILE;
}

export function getOpenclawDebugLogPath() {
  return OPENCLAW_LOG_FILE;
}
