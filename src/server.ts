import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, parseSidecarOptions } from './config.js';
import { addA1etherOpenAiAccount, listA1etherOpenAiAccounts, parseKeyPairText, removeA1etherOpenAiAccount } from './a1etheropenai-store.js';
import { addManagedAccount, listManagedAccounts, removeManagedAccount } from './account-store.js';
import {
  cancelLogin,
  deliverLoginCallback,
  deliverLoginCallbackToActiveProvider,
  pollLogin,
  startLogin,
} from './login-session.js';
import { describeRegistry, resolveAdapter } from './providers/index.js';
import { DashboardService } from './service.js';

// sidecar 选项要在 loadConfig() 之前解析：--config-dir 会重定位 .env / accounts.json 的基准目录，
// 而 loadConfig 一进来就 loadDotEnv。独立看板（不带参数）时它们全部保持默认，行为不变。
const sidecar = parseSidecarOptions();

// 静态资源根目录：--static-dir 优先（桌面版把 public/ 放进 App Resources，bun 编译后的
// import.meta.url 在虚拟文件系统里读不到真实目录）；缺省仍是 <dist>/../public/。
const PUBLIC_DIR = sidecar.staticDir ?? fileURLToPath(new URL('../public/', import.meta.url));

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

/**
 * 服务真实监听地址的 origin。
 *
 * 桌面版 sidecar 固定用 `--port 0` 让内核分配空闲端口，此时 `bootstrap.server.port`
 * 永远是 0，真实端口只有 `listen` 之后才能从 `server.address()` 读到。登录回调基址
 * 必须带真实端口——否则 Trae 授权页回跳会打开 `http://127.0.0.1:0/authorize`，
 * 浏览器直接以 ERR_UNSAFE_PORT 拒绝（网页版端口固定，所以不受影响）。
 */
function serverOrigin(): string {
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : bootstrap.server.port;
  return `http://${bootstrap.server.host}:${port}`;
}

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

/** 只保留字符串值的小工具：请求体里的 credentials / envRefs 都用它兜底 */
function stringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string' && item.trim()) out[key] = item;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
 * 本机特权操作的闸门：读密钥明文（/api/reveal）、增删账号（/api/a1etheropenai/accounts）。
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

/**
 * sidecar 令牌闸门：仅当配置了 token 时启用。/api/health 与静态资源放行（健康探测与
 * 独立看板静态页不需要），其余 /api/* 必须带匹配的 X-Power-Meter-Token 头或 ?token= 查询。
 * 与既有回环监听 + privilegedGuard 叠加，不改变独立看板（无 token）的任何行为。
 */
function tokenGate(req: IncomingMessage, url: URL): boolean {
  if (!sidecar.token) return true;
  const pathname = url.pathname;
  if (pathname === '/api/health' || !pathname.startsWith('/api/')) return true;
  const presented = req.headers['x-power-meter-token'] ?? url.searchParams.get('token');
  return presented === sidecar.token;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (pathname === '/api/health') {
      sendJson(res, 200, { ok: true, now: new Date().toISOString() });
      return;
    }

    if (!tokenGate(req, url)) {
      sendJson(res, 401, { error: '缺少或错误的访问令牌（X-Power-Meter-Token）' });
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

    /*
     * 通用账号管理（平台无关）：任何声明了 `manageAccounts` + `manageFields` 的适配器
     * 都能通过这三个接口增删账号，前端「＋ 添加账号」与 `npm run account` 共用同一份实现。
     * A1etherOpenAi 会被 src/account-store.ts 分派回它的专用存储层，行为不变。
     */
    if (pathname === '/api/accounts' && req.method === 'GET') {
      const guard = privilegedGuard(req);
      if (!guard.ok) {
        sendJson(res, guard.status, { error: guard.error });
        return;
      }
      const provider = url.searchParams.get('provider') ?? '';
      if (!resolveAdapter(provider)) {
        sendJson(res, 404, { error: `未知平台「${provider}」。` });
        return;
      }
      sendJson(res, 200, { provider, ...listManagedAccounts(provider) });
      return;
    }

    /*
     * 「平台与账号」总览：全部内置平台（含一个账号都没有的平台）+ 各自已配置的账号。
     *
     * 看板顶栏的入口用它渲染，解决「没有账号的平台在页面上完全没有添加入口」。
     * 只读、只回掩码；与 /api/accounts 一样只允许本机。
     */
    if (pathname === '/api/accounts/overview' && req.method === 'GET') {
      const guard = privilegedGuard(req);
      if (!guard.ok) {
        sendJson(res, guard.status, { error: guard.error });
        return;
      }
      const { config, warnings, missingEnvVars } = loadConfig();
      const providers = describeRegistry()
        .filter((item) => !item.isDemo)
        .map((item) => {
          let accounts: unknown[] = [];
          let providerWarnings: string[] = [];
          try {
            const listed = listManagedAccounts(item.id);
            accounts = listed.accounts;
            providerWarnings = listed.warnings;
          } catch (error) {
            providerWarnings = [`读取 ${item.displayName} 账号失败：${(error as Error).message}`];
          }
          return {
            id: item.id,
            displayName: item.displayName,
            region: item.region,
            credentialHint: item.credentialHint,
            manageAccounts: item.manageAccounts,
            manageFields: item.manageFields,
            manageHint: item.manageHint,
            login: item.login,
            accounts,
            warnings: providerWarnings,
          };
        });
      sendJson(res, 200, {
        accountsFilePath: config.accountsFilePath,
        warnings,
        missingEnvVars,
        providers,
      });
      return;
    }

    if (pathname === '/api/accounts/add' && req.method === 'POST') {
      const guard = privilegedGuard(req);
      if (!guard.ok) {
        sendJson(res, guard.status, { error: guard.error });
        return;
      }
      const body = (await readBody(req)) as {
        provider?: unknown;
        credentials?: unknown;
        envRefs?: unknown;
        /** option 字段（如 Qoder 的站点 site）：写进 accounts.json 的 options */
        options?: unknown;
        name?: unknown;
        force?: unknown;
        dryRun?: unknown;
      };
      const outcome = await addManagedAccount({
        provider: typeof body.provider === 'string' ? body.provider : '',
        credentials: stringRecord(body.credentials),
        envRefs: stringRecord(body.envRefs),
        options: stringRecord(body.options),
        name: typeof body.name === 'string' ? body.name : undefined,
        force: body.force === true,
        dryRun: body.dryRun === true,
        timeoutMs: bootstrap.settings.requestTimeoutMs + 6_000,
      });
      if (!outcome.ok) {
        sendJson(res, outcome.status, { error: outcome.error, stage: outcome.stage });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        provider: outcome.provider,
        name: outcome.name,
        credentials: outcome.credentials,
        options: outcome.options,
        envRefs: outcome.envRefs,
        backupDir: outcome.backupDir,
        details: outcome.details,
        dryRun: outcome.dryRun,
        // 回显这次加进去的账号长什么样（仍然只有掩码）
        account: {
          label: outcome.snapshot.plan ?? outcome.name,
          amount: outcome.snapshot.balance?.amount ?? 0,
          currency: outcome.snapshot.balance?.currency ?? 'CREDITS',
          note: outcome.snapshot.note,
          secrets: outcome.snapshot.secrets,
        },
      });
      return;
    }

    if (pathname === '/api/accounts/remove' && req.method === 'POST') {
      const guard = privilegedGuard(req);
      if (!guard.ok) {
        sendJson(res, guard.status, { error: guard.error });
        return;
      }
      const body = (await readBody(req)) as { provider?: unknown; accountId?: unknown };
      const outcome = removeManagedAccount(
        typeof body.provider === 'string' ? body.provider : '',
        typeof body.accountId === 'string' ? body.accountId : '',
      );
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

    // A1etherOpenAi 账号管理（兼容保留：CLI 与既有脚本用的是这套路径）：
    // 前置校验都在 a1etheropenai-store 里，与 npm run a1etheropenai:add 完全同一份实现
    if (pathname === '/api/a1etheropenai/accounts' && req.method === 'GET') {
      const guard = privilegedGuard(req);
      if (!guard.ok) {
        sendJson(res, guard.status, { error: guard.error });
        return;
      }
      const { accounts, missingEnvVars } = listA1etherOpenAiAccounts();
      sendJson(res, 200, { accounts, missingEnvVars });
      return;
    }

    if (pathname === '/api/a1etheropenai/accounts' && req.method === 'POST') {
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

      const outcome = await addA1etherOpenAiAccount({
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

    if (pathname === '/api/a1etheropenai/accounts/remove' && req.method === 'POST') {
      const guard = privilegedGuard(req);
      if (!guard.ok) {
        sendJson(res, guard.status, { error: guard.error });
        return;
      }
      const body = (await readBody(req)) as { accountId?: unknown };
      const accountId = typeof body.accountId === 'string' ? body.accountId : '';
      const outcome = removeA1etherOpenAiAccount(accountId);
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

    /*
     * 「扫码 / 打开链接登录」：平台无关的登录会话层（src/login-session.ts）。
     * 三个接口都走 privilegedGuard —— 它们会发起上游请求、并在成功后写本机配置。
     * 前端只拿到状态与 authUrl，令牌永远不经过 HTTP 响应。
     */
    if (pathname === '/api/login/start' && req.method === 'POST') {
      const guard = privilegedGuard(req);
      if (!guard.ok) {
        sendJson(res, guard.status, { error: guard.error });
        return;
      }
      const body = (await readBody(req)) as {
        provider?: unknown;
        method?: unknown;
        options?: unknown;
      };
      const provider = typeof body.provider === 'string' ? body.provider : '';
      const adapter = resolveAdapter(provider);
      if (!adapter) {
        sendJson(res, 404, { error: `未知平台「${provider}」。` });
        return;
      }
      // 方法选择交给会话层的 resolveLoginMethod：缺省 → login，
      // 带 method → 在 loginMethods 里按 id 查（查不到也会给 403）。
      // 这里只挡「完全没声明登录能力」的平台。
      if (!adapter.login && !(adapter.loginMethods?.length ?? 0)) {
        sendJson(res, 403, { error: `平台「${adapter.id}」未开放登录。` });
        return;
      }
      const outcome = await startLogin({
        provider: adapter.id,
        method: typeof body.method === 'string' ? body.method : undefined,
        options: stringRecord(body.options),
        callbackBase: serverOrigin(),
        timeoutMs: bootstrap.settings.requestTimeoutMs + 6_000,
        log: (message) => console.log(message),
      });
      if (!outcome.ok) {
        sendJson(res, outcome.status, { error: outcome.error });
        return;
      }
      sendJson(res, 200, { ok: true, session: outcome.session });
      return;
    }

    if (pathname === '/api/login/poll' && req.method === 'GET') {
      const guard = privilegedGuard(req);
      if (!guard.ok) {
        sendJson(res, guard.status, { error: guard.error });
        return;
      }
      const session = pollLogin(url.searchParams.get('id') ?? '');
      if (!session) {
        sendJson(res, 404, { error: '登录会话不存在或已清理。', status: 'invalid' });
        return;
      }
      sendJson(res, 200, { ok: true, session });
      return;
    }

    if (pathname === '/api/login/cancel' && req.method === 'POST') {
      const guard = privilegedGuard(req);
      if (!guard.ok) {
        sendJson(res, guard.status, { error: guard.error });
        return;
      }
      const body = (await readBody(req)) as { id?: unknown };
      const session = cancelLogin(typeof body.id === 'string' ? body.id : '');
      if (!session) {
        sendJson(res, 404, { error: '登录会话不存在或已清理。', status: 'invalid' });
        return;
      }
      sendJson(res, 200, { ok: true, session });
      return;
    }

    /*
     * Trae 的 OAuth 回调（唯一一条不经 privilegedGuard 的路由）：
     * 浏览器从 trae.cn 跳回来时不会带自定义头，所以改由三重约束保护——
     *   ① 只接受回环 Host；② 必须命中活跃登录会话；
     *   ③ 授权页域名由适配器白名单校验（见 trae.ts 的 traeHostAllowed）。
     * 回调只投递授权码，不返回任何令牌。
     *
     * 注意：Trae 授权页只接受裸回调地址 `http://127.0.0.1:<port>/authorize`，
     * 因此正常回调**不带** `lt`，按活跃会话反查；带 `lt` 的旧链接仍然兼容。
     */
    if (pathname === '/authorize' && req.method === 'GET') {
      if (!isLoopbackHost(hostnameOf(req.headers.host))) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden');
        return;
      }
      const sessionId = url.searchParams.get('lt') ?? '';
      const delivered = sessionId
        ? deliverLoginCallback(sessionId, url.searchParams)
        : deliverLoginCallbackToActiveProvider(url.searchParams);
      if (!delivered) {
        res
          .writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          .end('登录会话不存在或已失效，请回到看板重新发起登录。');
        return;
      }
      res
        .writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        .end(
          '<!doctype html><meta charset="utf-8"><title>登录完成</title>' +
            '<body style="font-family:system-ui;padding:48px;line-height:1.6">' +
            '<h1>登录完成</h1><p>可以关闭这个页面，回到看板继续。</p>' +
            '<script>setTimeout(function(){window.close()},800)</script>',
        );
      return;
    }

    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: `未知接口 ${pathname}` });
      return;
    }

    // sidecar 的 --no-static 模式：看板 UI 由 magpie GUI 渲染，这里不 serve public/，
    // 根路径给一条 JSON 指引而不是 404 的静态页，避免误以为是服务挂了。
    if (sidecar.noStatic) {
      if (pathname === '/' || pathname === '/index.html') {
        sendJson(res, 200, {
          service: 'power-meter',
          mode: 'sidecar',
          hint: '看板 UI 由 magpie GUI 渲染；这里是纯 API 服务。健康探测：/api/health，数据：/api/summary。',
        });
        return;
      }
      sendJson(res, 404, { error: 'sidecar 模式不 serve 静态资源（--no-static）' });
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
  // --port 0 时让内核分配随机空闲端口，真实端口从 address() 回读（bootstrap.server.port 仍是 0）。
  // sidecar 模式下 magpie 也从 stdout 这行解析端口，格式保持稳定：<service> listening at <url>
  const origin = serverOrigin();

  if (sidecar.noStatic || sidecar.token || sidecar.staticDir) {
    // sidecar / 桌面模式：一行可被 magpie 或 macOS 外壳解析的就绪信号，含端口与是否启用了令牌（不打印令牌本身）
    console.log(
      `[power-meter] listening at ${origin} mode=sidecar` +
        `${sidecar.noStatic ? ' no-static' : ''}` +
        `${sidecar.staticDir ? ' static=app' : ''} token=${sidecar.token ? 'on' : 'off'}`,
    );
  }
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
    console.log(
      `  提示：还没有启用的真实账号。打开 ${origin} → 顶栏「平台与账号」即可添加（无需编辑文件）\n`,
    );
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
