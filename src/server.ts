import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { addD1vAccount, listD1vAccounts, parseKeyPairText, removeD1vAccount } from './d1v-store.js';
import { describeRegistry, resolveAdapter } from './providers/index.js';
import { DashboardService } from './service.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

const service = new DashboardService();
const bootstrap = loadConfig().config;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** 只暴露「配置了什么」，不暴露凭证本身 */
function describeConfig(): unknown {
  const { config, warnings, missingEnvVars } = loadConfig();
  return {
    accountsFilePath: config.accountsFilePath,
    settings: config.settings,
    warnings,
    missingEnvVars,
    accounts: config.accounts.map((account) => ({
      provider: account.provider,
      displayName: account.displayName,
      enabled: account.enabled,
      credentialKeys: Object.keys(account.credentials),
      optionKeys: Object.keys(account.options),
      // 允许被 /api/reveal 读出的凭证 key（仍然只有名字，没有值）
      revealableKeys: (resolveAdapter(account.provider)?.revealableSecrets?.(account) ?? []).map(
        (secret) => secret.key,
      ),
    })),
  };
}

/**
 * 本机特权操作的闸门：读密钥明文（/api/reveal）、增删账号（/api/d1v/accounts）。
 *
 * 这几个接口能读出凭证、也能改本机配置文件，所以默认**只允许本机**：
 *   1. 服务自身监听在回环地址（`HOST` 默认 127.0.0.1 就是为此）；
 *      若改成 0.0.0.0，必须显式设 `ALLOW_SECRET_REVEAL=1` 才放行；
 *   2. 带 `Origin` 的请求（浏览器发起）必须也来自回环地址，
 *      否则 `evil.com` 可以用一段 JS 直接 POST 到 127.0.0.1 读密钥 / 删账号；
 *   3. 必须带自定义头 `X-Power-Meter-Intent`（值不限）。
 *      自定义头会让跨域请求必须先过 CORS 预检，而本服务不返回任何
 *      `Access-Control-Allow-*`，预检必然失败——等于给 CSRF 上了双保险。
 */
function privilegedGuard(
  req: IncomingMessage,
): { ok: true } | { ok: false; status: number; error: string } {
  if (process.env.ALLOW_SECRET_REVEAL !== '1' && !isLoopbackHost(hostnameOf(req.headers.host))) {
    return {
      ok: false,
      status: 403,
      error:
        '该操作仅允许从本机发起。若确需远程使用，请显式设置 ALLOW_SECRET_REVEAL=1 并自行为服务加鉴权。',
    };
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    if (!isLoopbackHost(hostnameOf(origin))) {
      return { ok: false, status: 403, error: `拒绝来自 ${origin} 的本机特权请求。` };
    }
  }
  const intent = req.headers['x-power-meter-intent'];
  if (typeof intent !== 'string' || intent.trim() === '') {
    return { ok: false, status: 400, error: '缺少 X-Power-Meter-Intent 请求头。' };
  }
  return { ok: true };
}

/** 从 `host` / `origin` 这类值里取主机名，兼容带端口与 IPv6 方括号的写法 */
function hostnameOf(value: string | undefined): string {
  if (!value) return '';
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

/**
 * 按需读出某条账号的托管密钥明文。
 *
 * 三重约束：只能是适配器 `revealableSecrets()` 声明过的 key、
 * 必须命中 accounts.json 里的具体账号、返回体不缓存不落日志。
 */
function revealSecret(
  body: { provider?: unknown; accountId?: unknown; key?: unknown },
): { status: number; payload: unknown } {
  const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  const accountId = typeof body.accountId === 'string' ? body.accountId : '';
  if (!provider || !key) {
    return { status: 400, payload: { error: 'provider 与 key 均为必填。' } };
  }

  // accountId 就是 accounts.json 里的 displayName（没写则是空串），
  // 与快照的 accountId / entries[].id 同源，不用再做任何拼接推断
  const { config } = loadConfig();
  const candidates = config.accounts.filter((item) => item.provider === provider);
  const account = candidates.find((item) => (item.displayName ?? '') === accountId);
  if (!account) {
    return {
      status: 404,
      payload: {
        error: `accounts.json 里找不到账号 ${provider}${accountId ? ` / ${accountId}` : ''}（共 ${candidates.length} 个同平台账号）。`,
      },
    };
  }
  if (candidates.filter((item) => (item.displayName ?? '') === accountId).length > 1) {
    return {
      status: 409,
      payload: {
        error: `平台 ${provider} 下有多个账号的 displayName 都是 "${accountId}"，无法定位。请给它们取不同的 displayName。`,
      },
    };
  }

  const adapter = resolveAdapter(account.provider);
  const declared = adapter?.revealableSecrets?.(account) ?? [];
  if (!declared.some((item) => item.key === key)) {
    return {
      status: 403,
      payload: { error: `平台 ${provider} 未声明可读取的凭证 "${key}"。` },
    };
  }

  const value = account.credentials[key];
  if (!value) {
    return { status: 404, payload: { error: `凭证 ${key} 为空，请在 .env 中补齐后重试。` } };
  }

  // 日志只记「谁被读了」，绝不记值
  console.log(`[reveal] ${provider}#${accountId || '(默认账号)'} ← ${key}`);
  return { status: 200, payload: { key, value } };
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = resolve(join(PUBLIC_DIR, relative));
  if (!target.startsWith(resolve(PUBLIC_DIR) + sep)) {
    res.writeHead(403).end('Forbidden');
    return true;
  }
  try {
    const content = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (pathname === '/api/health') {
      sendJson(res, 200, { ok: true, now: new Date().toISOString() });
      return;
    }

    if (pathname === '/api/providers') {
      sendJson(res, 200, { providers: describeRegistry() });
      return;
    }

    if (pathname === '/api/config') {
      sendJson(res, 200, describeConfig());
      return;
    }

    if (pathname === '/api/summary') {
      const force = url.searchParams.get('force') === '1';
      const outcome = force ? await service.refresh() : await service.getPayload();
      sendJson(res, 200, {
        ...outcome.payload,
        warnings: outcome.warnings,
        missingEnvVars: outcome.missingEnvVars,
      });
      return;
    }

    if (pathname === '/api/refresh' && req.method === 'POST') {
      const body = (await readBody(req)) as { providers?: unknown };
      const filter =
        Array.isArray(body.providers) && body.providers.length > 0
          ? body.providers.filter((item): item is string => typeof item === 'string')
          : undefined;
      const outcome = await service.refresh(filter);
      sendJson(res, 200, {
        ...outcome.payload,
        warnings: outcome.warnings,
        missingEnvVars: outcome.missingEnvVars,
      });
      return;
    }

    if (pathname === '/api/reveal' && req.method === 'POST') {
      const guard = privilegedGuard(req);
      if (!guard.ok) {
        sendJson(res, guard.status, { error: guard.error });
        return;
      }
      const body = (await readBody(req)) as {
        provider?: unknown;
        accountId?: unknown;
        key?: unknown;
      };
      const outcome = revealSecret(body);
      sendJson(res, outcome.status, outcome.payload);
      return;
    }

    // D1V 账号管理：前置校验都在 d1v-store 里，与 npm run d1v:add 完全同一份实现
    if (pathname === '/api/d1v/accounts' && req.method === 'GET') {
      const guard = privilegedGuard(req);
      if (!guard.ok) {
        sendJson(res, guard.status, { error: guard.error });
        return;
      }
      const { accounts, missingEnvVars } = listD1vAccounts();
      sendJson(res, 200, { accounts, missingEnvVars });
      return;
    }

    if (pathname === '/api/d1v/accounts' && req.method === 'POST') {
      const guard = privilegedGuard(req);
      if (!guard.ok) {
        sendJson(res, guard.status, { error: guard.error });
        return;
      }
      const body = (await readBody(req)) as {
        apiKey?: unknown;
        paiKey?: unknown;
        name?: unknown;
        text?: unknown;
        force?: unknown;
      };
      // 整段粘贴时由 store 解析「个人 / 项目」两把密钥
      const pasted = typeof body.text === 'string' ? parseKeyPairText(body.text) : null;
      const apiKey = (typeof body.apiKey === 'string' && body.apiKey) || pasted?.apiKey || '';
      const paiKey = (typeof body.paiKey === 'string' && body.paiKey) || pasted?.paiKey || '';

      const outcome = await addD1vAccount({
        apiKey,
        paiKey,
        name: typeof body.name === 'string' ? body.name : undefined,
        force: body.force === true,
        timeoutMs: bootstrap.settings.requestTimeoutMs + 6_000,
      });
      if (!outcome.ok) {
        sendJson(res, outcome.status, { error: outcome.error, stage: outcome.stage });
        return;
      }
      const secrets = outcome.snapshot.secrets;
      sendJson(res, 200, {
        ok: true,
        name: outcome.name,
        suffix: outcome.suffix,
        reused: outcome.reused,
        backupDir: outcome.backupDir,
        modelCount: outcome.modelCount,
        // 回显这次加进去的账号长什么样（仍然只有掩码）
        account: {
          label: outcome.snapshot.plan ?? outcome.name,
          amount: outcome.snapshot.balance?.amount ?? 0,
          currency: outcome.snapshot.balance?.currency ?? 'QUOTA',
          note: outcome.snapshot.note,
          secrets,
        },
      });
      return;
    }

    if (pathname === '/api/d1v/accounts/remove' && req.method === 'POST') {
      const guard = privilegedGuard(req);
      if (!guard.ok) {
        sendJson(res, guard.status, { error: guard.error });
        return;
      }
      const body = (await readBody(req)) as { accountId?: unknown };
      const accountId = typeof body.accountId === 'string' ? body.accountId : '';
      const outcome = removeD1vAccount(accountId);
      if (!outcome.ok) {
        sendJson(res, outcome.status, { error: outcome.error });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        name: outcome.name,
        removedEnvLines: outcome.removedEnvLines,
        backupDir: outcome.backupDir,
      });
      return;
    }

    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: `未知接口 ${pathname}` });
      return;
    }

    if (req.method === 'GET' && (await serveStatic(pathname, res))) return;
    sendJson(res, 404, { error: 'Not Found' });
  } catch (error) {
    console.error('[server] 未处理异常', error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: (error as Error).message });
    } else {
      res.end();
    }
  }
});

server.listen(bootstrap.server.port, bootstrap.server.host, () => {
  const origin = `http://${bootstrap.server.host}:${bootstrap.server.port}`;
  console.log(`\n  Power Meter 已启动  ${origin}`);
  console.log(`  接口: ${origin}/api/summary   配置概览: ${origin}/api/config`);
  console.log(`  账号文件: ${bootstrap.accountsFilePath}`);
  console.log(`  缓存 TTL: ${bootstrap.settings.cacheTtlSeconds}s\n`);

  const exposingSecrets = process.env.ALLOW_SECRET_REVEAL === '1';
  const reachableFromLan = !isLoopbackHost(bootstrap.server.host);
  if (exposingSecrets || reachableFromLan) {
    console.warn(
      '  ⚠ 密钥读取接口 /api/reveal 已对非本机来源开放' +
        (exposingSecrets ? '（ALLOW_SECRET_REVEAL=1）' : `（HOST=${bootstrap.server.host}）`) +
        '，请确保前面有反向代理鉴权。\n',
    );
  }
  if (!service.accounts.some((account) => account.enabled && !account.provider.startsWith('demo:'))) {
    console.log('  提示：当前只有示例数据，配置真实凭证请编辑 accounts.json（保存后自动生效）\n');
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
