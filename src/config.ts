import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const envWithLegacyAlias = (
  current: string,
  legacy: string,
  fallback: string,
): string => process.env[current] || process.env[legacy] || fallback;

export const ASSISTANT_NAME = envWithLegacyAlias(
  'MINICLAW_ASSISTANT_NAME',
  'ASSISTANT_NAME',
  'Miniclaw',
);
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;
// Conversation/spawn sessions with no activity for this long are archived to
// 'completed'; a new message in the bound thread still revives the session.
export const CONVERSATION_AGENT_ARCHIVE_DAYS = 30;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();

// Mount security: allowlist in project config/ directory
export const MOUNT_ALLOWLIST_PATH = path.resolve(
  PROJECT_ROOT,
  'config',
  'mount-allowlist.json',
);
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const STORE_DIR = path.join(DATA_DIR, 'db');
export const GROUPS_DIR = path.join(DATA_DIR, 'groups');
export const MAIN_GROUP_FOLDER = 'main';

// 文件大小上限（MB）。Web 文件面板上传与 IM 渠道收文件（feishu/telegram/qq/
// dingtalk/discord/wechat inbound）共用此上限。注意：Web 下载是流式返回已存在
// 的文件，不受此上限约束。通过 MAX_FILE_SIZE_MB 环境变量调整（默认 50MB）；
// 非法值回退到 50。
const _maxFileSizeMb = parseInt(process.env.MAX_FILE_SIZE_MB || '50', 10);
export const MAX_FILE_SIZE_MB =
  Number.isFinite(_maxFileSizeMb) && _maxFileSizeMb > 0 ? _maxFileSizeMb : 50;
export const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024;

export const CONTAINER_IMAGE = envWithLegacyAlias(
  'MINICLAW_CONTAINER_IMAGE',
  'CONTAINER_IMAGE',
  'helsome/miniclaw-agent:latest',
);
// Timezone for scheduled tasks (cron expressions, etc.)
// Uses TZ env var with Asia/Shanghai fallback
export const TIMEZONE =
  process.env.TZ ||
  Intl.DateTimeFormat().resolvedOptions().timeZone ||
  'Asia/Shanghai';

// Web server configuration
export const WEB_PORT = parseInt(process.env.WEB_PORT || '3000', 10);

// Cookie configuration
// When accessed over HTTPS: use __Host- prefix (requires Secure; Path=/; no Domain)
// When accessed over HTTP (localhost dev or no TLS): use plain name
// Determined per-request via isSecureRequest(), not at startup
export const SESSION_COOKIE_NAME_SECURE = '__Host-miniclaw_session';
export const SESSION_COOKIE_NAME_PLAIN = 'miniclaw_session';
export const LEGACY_SESSION_COOKIE_NAME_SECURE = SESSION_COOKIE_NAME_SECURE;
export const LEGACY_SESSION_COOKIE_NAME_PLAIN = SESSION_COOKIE_NAME_PLAIN;
const SESSION_SECRET_FILE = path.join(DATA_DIR, 'config', 'session-secret.key');

function getOrCreateSessionSecret(): string {
  // 1. Environment variable (highest priority — allows container/operator override)
  if (process.env.WEB_SESSION_SECRET) {
    return process.env.WEB_SESSION_SECRET;
  }

  // 2. File-persisted secret (survives restarts)
  try {
    if (fs.existsSync(SESSION_SECRET_FILE)) {
      const stored = fs.readFileSync(SESSION_SECRET_FILE, 'utf-8').trim();
      if (stored) return stored;
    }
  } catch {
    // ignore read errors, fall through
  }

  // 3. Generate and persist
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(SESSION_SECRET_FILE), { recursive: true });
    fs.writeFileSync(SESSION_SECRET_FILE, generated + '\n', {
      encoding: 'utf-8',
      mode: 0o600,
    });
  } catch {
    // non-fatal: secret works for this process, just won't survive restart
  }
  return generated;
}

export const WEB_SESSION_SECRET = getOrCreateSessionSecret();

// Proxy trust configuration
// Set TRUST_PROXY=true when behind a reverse proxy (nginx, Cloudflare, etc.)
export const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

// Docker availability check (cached for the lifetime of the process)
const execFileAsync = promisify(execFile);
let _dockerAvailable: boolean | null = null;

export async function isDockerAvailable(): Promise<boolean> {
  if (_dockerAvailable !== null) return _dockerAvailable;
  try {
    await execFileAsync('docker', ['info'], { timeout: 10000 });
    _dockerAvailable = true;
  } catch {
    _dockerAvailable = false;
  }
  return _dockerAvailable;
}
