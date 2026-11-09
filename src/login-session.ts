/**
 * 平台无关的登录会话层：发起、后台轮询、取消、落库。
 *
 * 谁用它：任何在 `ProviderAdapter` 上声明了 `login` 的适配器
 * （当前是 CodeBuddy / Qoder / Trae），由 `src/server.ts` 的 `/api/login/*`
 * 与 Trae 的 `/authorize` 回调驱动。
 *
 * 设计要点（详见 docs/plans/账号管理-扫码与链接登录-开发设计方案.md §3.4）：
 *   1. **后台轮询**：`start` 后立即启动，不依赖前端；前端只读本地状态，
 *      关掉弹窗再打开也能看到结果。
 *   2. **单平台单会话**：同一 provider 再次 `start` 会取消旧会话，
 *      避免两个二维码 / 两个 state 互相混淆。
 *   3. **终态缓存**：ready / failed / expired / cancelled 保留到 TTL 结束，
 *      重复 `poll` 直接返回，避免重复落库。
 *   4. **不落日志**：令牌、refresh token、authUrl 全文、PKCE verifier、设备私钥
 *      一律不进日志；错误信息只带上游状态与可操作原因。
 *   5. **落库在会话层**：`ready` 之前已经完成 probe 验证与写入，
 *      前端看到 `ready` 时卡片已经可以出现。
 */
import { randomUUID } from 'node:crypto';
import { landLoginAccount, type LandLoginResult } from './account-store.js';
import { resolveLoginMethod, type ProbeContext, type ProviderLogin } from './providers/base.js';
import { resolveAdapter } from './providers/index.js';

export type LoginSessionStatus =
  | 'waiting'
  | 'landing'
  | 'ready'
  | 'expired'
  | 'failed'
  | 'cancelled'
  | 'invalid';

export interface LoginSessionView {
  id: string;
  provider: string;
  /** 登录方法标识（`ProviderLogin.id`，未声明方法的平台为 `default`） */
  method: string;
  status: LoginSessionStatus;
  /** 授权页链接；`waiting` / `landing` 时才有值 */
  authUrl: string | null;
  /** 该链接能否跨设备扫码 */
  qr: boolean;
  hint: string;
  /** 状态补充说明（等待文案 / 失败原因 / 落库结果） */
  message: string | null;
  createdAt: number;
  expiresAt: number;
  /** ready 时落库结果 */
  account: { name: string; updated: boolean } | null;
}

interface LoginSession {
  id: string;
  provider: string;
  method: string;
  status: LoginSessionStatus;
  authUrl: string | null;
  qr: boolean;
  hint: string;
  message: string | null;
  createdAt: number;
  expiresAt: number;
  /** 卡片级「重新登录」指定的原账号（`accounts.json` displayName）；空串 = 新增账号 */
  targetAccountId: string;
  /** 适配器私有状态（state / verifier / 设备私钥），只留在内存 */
  secret: unknown;
  login: ProviderLogin;
  timer: NodeJS.Timeout | null;
  /** 防止后台轮询与落库重入 */
  polling: boolean;
  account: { name: string; updated: boolean } | null;
}

const SESSIONS = new Map<string, LoginSession>();
/** 每个 `provider#method` 当前活跃（非终态）的会话 id——扫码与网页登录互不挤占 */
const ACTIVE = new Map<string, string>();

const TERMINAL: ReadonlySet<LoginSessionStatus> = new Set([
  'ready',
  'expired',
  'failed',
  'cancelled',
]);

function view(session: LoginSession): LoginSessionView {
  return {
    id: session.id,
    provider: session.provider,
    method: session.method,
    status: session.status,
    authUrl: session.status === 'waiting' || session.status === 'landing' ? session.authUrl : null,
    qr: session.qr,
    hint: session.hint,
    message: session.message,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    account: session.account,
  };
}

function clearTimer(session: LoginSession): void {
  if (session.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }
}

/**
 * 终态后释放 secret 与登录期资源。
 *
 * `cleanup` 先于置空调用：CDP 采集器这类挂在 secret 里的资源
 * 必须在 secret 还可读时释放；释放失败静默，不影响状态上报。
 */
function settle(session: LoginSession, status: LoginSessionStatus, message: string | null): void {
  session.status = status;
  session.message = message;
  if (session.secret !== null && session.login.cleanup) {
    try {
      void Promise.resolve(session.login.cleanup(session.secret)).catch(() => {});
    } catch {
      // 释放失败不阻断状态流转
    }
  }
  session.secret = null;
  clearTimer(session);
  const activeKey = `${session.provider}#${session.method}`;
  if (ACTIVE.get(activeKey) === session.id) ACTIVE.delete(activeKey);
}

/** 清理过期会话：终态保留到 TTL，等待中的超时即 expired */
export function pruneLoginSessions(now = Date.now()): void {
  for (const [id, session] of SESSIONS) {
    if (now < session.expiresAt) continue;
    if (!TERMINAL.has(session.status)) {
      settle(session, 'expired', '登录已超时，请重新获取二维码或链接。');
      // 超时后仍然保留一小段时间，让前端能读到 expired
      session.expiresAt = now + 30_000;
      continue;
    }
    SESSIONS.delete(id);
  }
}

export interface StartLoginInput {
  provider: string;
  /**
   * 卡片级「重新登录」的目标账号（`accounts.json` displayName）。
   * 非空时会话层在 `ready` 落库时原地更新该条目，绝不新增卡片；
   * 弹窗里的「登录 / 添加账号」不传，走身份去重。
   */
  targetAccountId?: string;
  /** 用哪个登录方法（`ProviderLogin.id`）；缺省 = 平台默认方法（`login`） */
  method?: string;
  options?: Record<string, string>;
  /** 服务自身的回环基址（Trae 拼回调地址用） */
  callbackBase: string;
  timeoutMs?: number;
  log?: (message: string) => void;
}

export type StartLoginResult =
  | { ok: true; session: LoginSessionView }
  | { ok: false; status: number; error: string };

/**
 * 发起登录：按 `method` 选方法、申请 authUrl、建会话、启动后台轮询。
 *
 * 同一「平台 + 方法」已有活跃会话时先取消它（旧二维码随即失效）——
 * 用户重新点「获取二维码」时，旧码不应还能把账号登进来。
 * 不同方法（扫码 vs 网页端）互不挤占，可同时各挂一个。
 */
export async function startLogin(input: StartLoginInput): Promise<StartLoginResult> {
  pruneLoginSessions();
  const adapter = resolveAdapter((input.provider ?? '').trim());
  if (!adapter) {
    return { ok: false, status: 404, error: `未知平台「${input.provider}」。` };
  }
  const method = resolveLoginMethod(adapter, input.method);
  if (!method) {
    return { ok: false, status: 403, error: `平台「${adapter.id}」未声明登录能力。` };
  }
  const methodId = method.id ?? 'default';

  const activeKey = `${adapter.id}#${methodId}`;
  const previousId = ACTIVE.get(activeKey);
  if (previousId) {
    const previous = SESSIONS.get(previousId);
    if (previous) settle(previous, 'cancelled', '已被同一平台的新登录请求取代。');
  }

  const sessionId = randomUUID();
  const now = Date.now();
  const timeoutMs = input.timeoutMs ?? 15_000;
  const log = input.log ?? (() => {});

  let started;
  try {
    started = await method.start({
      now,
      timeoutMs,
      sessionId,
      callbackBase: input.callbackBase,
      options: { ...(input.options ?? {}) },
      log: (message) => log(`[login:${adapter.id}] ${message}`),
    });
  } catch (error) {
    return { ok: false, status: 502, error: `申请登录链接失败：${(error as Error).message}` };
  }

  const session: LoginSession = {
    id: sessionId,
    provider: adapter.id,
    method: methodId,
    status: 'waiting',
    authUrl: started.authUrl,
    qr: started.qr && method.qr,
    hint: started.hint ?? method.hint,
    message: '等待扫码 / 授权…',
    createdAt: now,
    expiresAt: now + (started.ttlMs > 0 ? started.ttlMs : 5 * 60 * 1000),
    targetAccountId: (input.targetAccountId ?? '').trim(),
    secret: started.secret,
    login: method,
    timer: null,
    polling: false,
    account: null,
  };
  SESSIONS.set(sessionId, session);
  ACTIVE.set(activeKey, sessionId);
  schedulePoll(session, method.intervalMs ?? 2_000, timeoutMs, log);
  return { ok: true, session: view(session) };
}

function schedulePoll(
  session: LoginSession,
  intervalMs: number,
  timeoutMs: number,
  log: (message: string) => void,
): void {
  clearTimer(session);
  session.timer = setTimeout(() => {
    void tick(session, intervalMs, timeoutMs, log);
  }, intervalMs);
  // 后台轮询不应阻止进程退出（dev 热重载 / Ctrl+C）
  session.timer.unref?.();
}

async function tick(
  session: LoginSession,
  intervalMs: number,
  timeoutMs: number,
  log: (message: string) => void,
): Promise<void> {
  if (session.polling || TERMINAL.has(session.status)) return;
  if (Date.now() >= session.expiresAt) {
    settle(session, 'expired', '登录已超时，请重新获取二维码或链接。');
    return;
  }

  session.polling = true;
  try {
    const ctx: ProbeContext = {
      now: Date.now(),
      timeoutMs,
      log: (message) => log(`[login:${session.provider}] ${message}`),
    };
    const result = await session.login.poll(session.secret, ctx);

    if (result.status === 'waiting') {
      if (result.message) session.message = result.message;
      schedulePoll(session, intervalMs, timeoutMs, log);
      return;
    }
    if (result.status === 'failed') {
      settle(session, 'failed', result.message);
      return;
    }

    // ready：先落库（probe 验证 + 写 .env / accounts.json），成功才对外报 ready
    session.status = 'landing';
    session.message = result.message ?? '登录成功，正在验证取数并写入本机配置…';
    const landed: LandLoginResult = await landLoginAccount({
      provider: session.provider,
      accountId: result.account.id,
      targetAccountId: session.targetAccountId,
      accountName: result.account.name,
      credentials: result.credentials,
      options: result.options,
      timeoutMs,
    });
    if (!landed.ok) {
      settle(session, 'failed', landed.error);
      return;
    }
    session.account = { name: landed.name, updated: landed.updated };
    settle(
      session,
      'ready',
      landed.updated
        ? `已更新「${landed.name}」的登录凭证`
        : `已添加「${landed.name}」`,
    );
  } catch (error) {
    // 网络抖动不直接判死：TTL 内继续轮询；只有确定性错误才落 failed
    const message = (error as Error).message;
    log(`[login:${session.provider}] 轮询失败：${message}`);
    if (/401|403|invalid|无效|失效|未授权/i.test(message)) {
      settle(session, 'failed', `登录失败：${message}`);
      return;
    }
    if (Date.now() < session.expiresAt) {
      schedulePoll(session, intervalMs, timeoutMs, log);
    } else {
      settle(session, 'expired', '登录已超时，请重新获取二维码或链接。');
    }
  } finally {
    session.polling = false;
  }
}

/** 读会话状态；终态原样返回（不重复落库） */
export function pollLogin(sessionId: string): LoginSessionView | null {
  pruneLoginSessions();
  const session = SESSIONS.get((sessionId ?? '').trim());
  return session ? view(session) : null;
}

/** 用户取消 / 关闭弹窗 */
export function cancelLogin(sessionId: string): LoginSessionView | null {
  const session = SESSIONS.get((sessionId ?? '').trim());
  if (!session) return null;
  if (!TERMINAL.has(session.status)) settle(session, 'cancelled', '已取消。');
  return view(session);
}

/**
 * 投递浏览器回调（Trae 的 `/authorize`）。
 * 返回 true = 某个会话接收了这次回调；false = 没有匹配的会话。
 */
export function deliverLoginCallback(sessionId: string, query: URLSearchParams): boolean {
  const session = SESSIONS.get((sessionId ?? '').trim());
  if (!session || TERMINAL.has(session.status)) return false;
  if (!session.login.handleCallback) return false;
  try {
    return Boolean(session.login.handleCallback(session.secret, query));
  } catch {
    return false;
  }
}

/**
 * 不带会话 id 的回调投递：上游会校验回调地址（Trae 只接受裸
 * `http://127.0.0.1:<port>/authorize`），所以不能把 `lt` 拼进地址。
 * 这里改为遍历活跃会话，交给声明了 `handleCallback` 的适配器自己判定；
 * 每个 provider 同时只有一个活跃会话（`ACTIVE`），不存在跨会话歧义。
 * 返回 true = 某个会话接收了这次回调。
 */
export function deliverLoginCallbackToActiveProvider(query: URLSearchParams): boolean {
  pruneLoginSessions();
  for (const sessionId of Array.from(ACTIVE.values())) {
    if (deliverLoginCallback(sessionId, query)) return true;
  }
  return false;
}

/** 供测试 / 诊断：当前活跃会话数 */
export function activeLoginCount(): number {
  return ACTIVE.size;
}
