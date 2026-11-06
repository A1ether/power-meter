/**
 * 调试 Chrome 的 CDP 客户端：探活 / 拉起浏览器 / 打开页面 / 采集**真实请求头里的 Cookie**。
 *
 * 为什么不复用 `src/cli/capture.ts`：
 *   那个文件是「手工抓取」的 CLI —— 末尾是裸 `main();`（引入即执行整个脚本）、
 *   中途有 `process.exit(1)`、依赖阻塞的 `execFileSync` 与外部 `curl`，
 *   还把 `process.argv` 解析成**模块级常量**。服务端引入它会直接跑一遍 CLI 并卡住事件循环。
 *   这里只实现服务端需要的那部分：全异步、零第三方依赖（Node 内置 `fetch` + `WebSocket`）。
 *
 * 为什么取「浏览器真实发出的 Cookie 头」而不是拼 cookie jar：
 *   jar 里可能含平台无关的超大 Cookie（CodeBuddy 的 Keycloak 一组约 9KB），
 *   全拼上会超过 nginx 的 client header 上限而直接 401；
 *   浏览器只发送当前域 + 当前路径真正需要的那部分，那才是对的。
 *   （同 `src/cli/capture.ts:445-452` 的踩坑记录。）
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

/** CDP 端点：与 `src/cli/capture.ts` 保持同一默认值，便于共用同一个调试 Chrome */
export const DEFAULT_CDP_ENDPOINT = 'http://127.0.0.1:9222';

const DEFAULT_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEFAULT_PROFILE_DIR = `${homedir()}/.power-meter/chrome-profile`;

/** 单条 CDP 报文的形状（事件无 id，响应有 id） */
interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: unknown;
  error?: { message?: string };
}

type CdpEventHandler = (params: Record<string, unknown>, sessionId: string | null) => void;

/**
 * 一条到 CDP 的 WebSocket 连接：请求/响应按自增 id 配对，事件按 method 分发。
 *
 * 用 Node 内置 `WebSocket`（Node 22+ 提供，本项目 `@types/node` 已声明），
 * 因此不需要 playwright / puppeteer 这类运行时依赖。
 */
class CdpConnection {
  private seq = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly listeners = new Map<string, Set<CdpEventHandler>>();
  private closed = false;

  private constructor(private readonly ws: WebSocket) {
    this.ws.addEventListener('message', (event) => {
      const raw = (event as { data?: unknown }).data;
      const text = typeof raw === 'string' ? raw : '';
      if (!text) return;
      let message: CdpMessage;
      try {
        message = JSON.parse(text) as CdpMessage;
      } catch {
        return; // 非 JSON 报文直接忽略，不让脏数据打断采集
      }
      if (typeof message.id === 'number') {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(message.error.message ?? 'CDP 调用失败'));
        else entry.resolve(message.result);
        return;
      }
      if (!message.method) return;
      const handlers = this.listeners.get(message.method);
      if (!handlers) return;
      for (const handler of handlers) {
        try {
          handler(message.params ?? {}, message.sessionId ?? null);
        } catch {
          // 单个订阅者抛错不影响其他订阅者
        }
      }
    });
    this.ws.addEventListener('close', () => {
      this.closed = true;
      // 连接断开时把在途请求全部拒绝，避免调用方永久挂起
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error('CDP 连接已断开'));
        this.pending.delete(id);
      }
    });
  }

  /** 连上 WebSocket 并等待 open；超时或失败即抛错（不静默降级，由调用方决定文案） */
  static connect(url: string, timeoutMs: number): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch (error) {
        reject(new Error(`无法连接 CDP：${(error as Error).message}`));
        return;
      }
      const timer = setTimeout(() => {
        reject(new Error('连接调试 Chrome 超时'));
        try {
          socket.close();
        } catch {
          // 关闭失败无所谓：已经准备放弃了
        }
      }, timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new CdpConnection(socket));
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('无法连接调试 Chrome（WebSocket 打开失败）'));
      });
    });
  }

  /** 发一条 CDP 命令；`sessionId` 存在时发给目标会话（flatten 模式） */
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 10_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'));
    const id = this.seq;
    this.seq += 1;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`CDP 命令发送失败：${(error as Error).message}`));
      }
    });
  }

  /** 订阅事件；返回取消订阅函数 */
  on(method: string, handler: CdpEventHandler): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(handler);
    return () => set?.delete(handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      // 已断开
    }
  }
}

/** 从 `http://127.0.0.1:9222` 这类端点里取端口，供拉起 Chrome 时复用 */
function portOf(endpoint: string): string {
  const matched = /:(\d+)\/?$/.exec(endpoint.trim());
  return matched?.[1] ?? '9222';
}

/** `GET {endpoint}/json/version` 探活；返回浏览器描述，失败返回 null */
async function probeChrome(endpoint: string, timeoutMs = 3_000): Promise<string | null> {
  try {
    const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const body = (await response.json()) as { Browser?: unknown };
    return typeof body.Browser === 'string' ? body.Browser : 'Chrome';
  } catch {
    return null;
  }
}

export interface EnsureChromeResult {
  /** 是否本次由我们拉起（用于提示用户「可以关掉那个窗口了」） */
  started: boolean;
  /** 浏览器自述版本串 */
  browser: string;
}

/**
 * 确保调试 Chrome 在跑：先探活，没跑就按 `tools/chrome-debug.sh` 同款参数拉起。
 *
 * 参数刻意与那个脚本保持一致（独立 profile、`--no-first-run` 等）：
 *   Chrome 136+ 禁止对默认 user-data-dir 开启 `--remote-debugging-port`（传了会被静默忽略），
 *   因此必须用独立 profile，且与用户日常浏览器完全隔离。
 *
 * 拉起用 `detached` + `unref`：服务端不持有它的生命周期，用户可随时关掉窗口。
 */
export async function ensureDebugChrome(options?: {
  endpoint?: string;
  chromePath?: string;
  profileDir?: string;
  timeoutMs?: number;
}): Promise<EnsureChromeResult> {
  const endpoint = (options?.endpoint ?? process.env.CDP_ENDPOINT ?? DEFAULT_CDP_ENDPOINT).replace(/\/+$/, '');
  const already = await probeChrome(endpoint);
  if (already) return { started: false, browser: already };

  const chromePath = options?.chromePath ?? process.env.CHROME_BIN ?? DEFAULT_CHROME_PATH;
  if (!existsSync(chromePath)) {
    throw new Error(
      `找不到 Chrome：${chromePath}。可设置环境变量 CHROME_BIN 指定路径，` +
        '或先手动执行 `npm run chrome:debug`。',
    );
  }

  const profileDir = options?.profileDir ?? process.env.POWER_METER_CHROME_PROFILE ?? DEFAULT_PROFILE_DIR;
  const port = portOf(endpoint);
  const child = spawn(
    chromePath,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-features=Translate,OptimizationHints',
      'about:blank',
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();

  // 等它就绪：冷启动可能要几秒
  const deadline = Date.now() + (options?.timeoutMs ?? 15_000);
  for (;;) {
    const browser = await probeChrome(endpoint, 1_500);
    if (browser) return { started: true, browser };
    if (Date.now() >= deadline) {
      throw new Error(`已拉起 Chrome 但调试端口 ${port} 未就绪，请稍后重试或改用手工 Cookie。`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * 从 Cookie 头里取 Cookie 名清单（只回传名字，不回传值）。
 *
 * 供适配器做「登录态判据」：访客 Cookie 与登录态 Cookie 的区别只在名字上，
 * 值本身既不需要、也不应该离开采集器。
 */
export function cookieNamesOf(header: string): string[] {
  return header
    .split(';')
    .map((part) => part.trim().split('=')[0]?.trim() ?? '')
    .filter(Boolean);
}

/**
 * 主机是否属于目标站点：同域或**目标站的子域**。
 *
 * 不再接受「目标站的父域」（`site.endsWith('.' + host)`）——那会让 `qoder.com.cn`
 * 的请求把 `com.cn` 上的 Cookie 也算成命中。父域方向的放宽在 `capture.ts` 的
 * cookie jar 场景有意义（jar 里的 domain 可能写成父域），但这里取的是浏览器
 * **真实发出的头**，归属天然精确，无需放宽。
 */
export function hostMatches(host: string, site: string): boolean {
  const normalizedHost = host.replace(/^\./, '').toLowerCase();
  const normalizedSite = site.replace(/^\./, '').toLowerCase();
  if (!normalizedHost || !normalizedSite) return false;
  return normalizedHost === normalizedSite || normalizedHost.endsWith(`.${normalizedSite}`);
}

/** 从任意 request 头对象里取 Cookie（CDP 大小写归一到 `Cookie`，这里两种都认） */
function cookieOfHeaders(headers: unknown): string {
  if (!headers || typeof headers !== 'object') return '';
  const record = headers as Record<string, unknown>;
  const raw = record.Cookie ?? record.cookie;
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * `Network.requestWillBeSentExtraInfo` 的 `associatedCookies` 里取一个归属域。
 *
 * 该字段是 CDP 里唯一能告诉我们「这条请求的 Cookie 属于哪个域」的旁证
 * （`requestWillBeSent` 只给 url、`ExtraInfo` 只给 headers + 这个数组）。
 * 只作为**次要**归属信号：主路径用 `requestId` 关联两个事件。
 */
function domainOfAssociatedCookies(associated: unknown): string {
  if (!Array.isArray(associated)) return '';
  for (const item of associated) {
    if (!item || typeof item !== 'object') continue;
    // 被浏览器拦掉的 Cookie 不代表真实发送，不能作为归属依据
    if ((item as { blocked?: unknown }).blocked === true) continue;
    const cookie = (item as { cookie?: unknown }).cookie;
    if (!cookie || typeof cookie !== 'object') continue;
    const domain = (cookie as { domain?: unknown }).domain;
    if (typeof domain === 'string' && domain.trim()) return domain.trim().replace(/^\./, '');
  }
  return '';
}

/** 把 URL 解析成主机名；解析失败返回空串 */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export interface CookieCollector {
  /** 取指定站点域上已采集到的 Cookie 头；没有则返回 null */
  cookieFor(sites: string[]): string | null;
  /**
   * 取指定站点域上已采集到的 Cookie **名**清单（不含值）。
   *
   * 给适配器做「登录态判据」用：访客 Cookie 与登录态 Cookie 的差别只在名字上，
   * 值不该离开采集器，更不该进入日志或 HTTP 响应。
   */
  cookieNamesFor(sites: string[]): string[];
  /**
   * 页面**自己**请求过的、以 `pathSuffix` 结尾的地址是否拿到 2xx。
   *
   * 这是站点无关的功能性证据：登录态下身份接口返回 200、访客态返回 401
   * （Qoder 实测：`/api/v1/me` 200 vs 401）。当登录态 Cookie 名随上游改版变化时，
   * 适配器仍能靠它判定「确实登录成功了」。
   */
  sawSuccessfulRequest(pathSuffix: string): boolean;
  /**
   * 距上一次采到任何网络事件过去了多少毫秒（从未采到返回 0）。
   *
   * 供适配器决定「要不要刷新页面」：页面正在发请求（用户在登录/页面在轮询）
   * 时不应刷新——刷新会重置用户正在填写的表单；只有页面**确实空闲**时才值得刷。
   */
  idleMs(): number;
  /** 重新加载当前页面，触发新一轮请求（用于用户刚登录完、页面还没发请求的场景） */
  reload(): Promise<void>;
  /**
   * 读取页面 `localStorage` 的字符串值；未设置 / 不可读时返回空串。
   *
   * 只供「登录态存在 localStorage 里」的平台使用（MiniMax 的 `_token`、
   * `UNIQUE_USER_ID`）。值不离开服务端，也不会写进日志或 HTTP 响应。
   */
  localStorageItem(key: string): Promise<string>;
  /**
   * 读取页面 `localStorage` 里的 JSON 对象（如 MiniMax 的 `user_detail_agent`）；
   * 不存在 / 不是合法对象时返回 null。
   */
  localStorageObject(key: string): Promise<Record<string, unknown> | null>;
  /** 关掉我们开出来的标签页与连接（不关闭整个浏览器） */
  close(): Promise<void>;
}

/**
 * 开一个标签页并采集它发出的请求头里的 Cookie。
 *
 * 用浏览器级连接 + `Target.createTarget` 新开标签页，而不是复用现有标签页：
 * 用户可能开着别的页面，导航他的标签页会打断他。
 */
export async function openCookieCollector(options: {
  endpoint?: string;
  url: string;
  timeoutMs?: number;
}): Promise<CookieCollector> {
  const endpoint = (options.endpoint ?? process.env.CDP_ENDPOINT ?? DEFAULT_CDP_ENDPOINT).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 10_000;

  // 浏览器级 WebSocket：只有它能调 Target.* 开新标签页
  let browserWsUrl = '';
  try {
    const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(3_000) });
    const body = (await response.json()) as { webSocketDebuggerUrl?: unknown };
    if (typeof body.webSocketDebuggerUrl === 'string') browserWsUrl = body.webSocketDebuggerUrl;
  } catch {
    // 落到下面的统一报错
  }
  if (!browserWsUrl) throw new Error('调试 Chrome 未就绪（拿不到 webSocketDebuggerUrl）');

  const browser = await CdpConnection.connect(browserWsUrl, timeoutMs);

  const created = (await browser.send('Target.createTarget', { url: options.url })) as { targetId?: string };
  const targetId = created?.targetId;
  if (!targetId) {
    browser.close();
    throw new Error('无法在调试 Chrome 中新建标签页');
  }
  const attached = (await browser.send('Target.attachToTarget', { targetId, flatten: true })) as {
    sessionId?: string;
  };
  const sessionId = attached?.sessionId;
  if (!sessionId) {
    browser.close();
    throw new Error('无法附着到新建的标签页');
  }

  // 已采集到的 Cookie：host → 头值。xhr/fetch 优先，其它类型兜底
  const byHost = new Map<string, string>();
  const fallbackByHost = new Map<string, string>();

  /**
   * 采集靠 `requestId` 把两个事件拼起来：
   *
   *   - `Network.requestWillBeSent`        → 只提供 url（→ host）与 resourceType
   *   - `Network.requestWillBeSentExtraInfo` → 只提供真实请求头（Cookie 在这里）
   *
   * 为什么必须这样拼（Chrome 155 实测，见 docs/fixes/Qoder-网页端登录一直等待-修复方案.md §2）：
   *   1. `requestWillBeSent.request.headers` 里**从来没有** Cookie（XHR/Fetch 14/14 为空），
   *      旧实现读它 → 恒取不到；
   *   2. `ExtraInfo` 的参数里**没有** host / url（协议只有 requestId / associatedCookies /
   *      headers / connectTiming / ...），旧实现读 `params.host` → 恒为空串；
   *   3. 两个事件到达顺序**不固定**（实测同一 requestId 上 ExtraInfo 先到 17 次、
   *      requestWillBeSent 先到 23 次），所以必须双向缓冲：谁后到谁负责补齐。
   */
  const requestMeta = new Map<string, { host: string; path: string; type: string }>();
  const cookieByRequest = new Map<string, string>();
  /** 页面**自己**请求成功（2xx）过的 pathname，供适配器做功能性登录判据 */
  const successPaths = new Set<string>();
  /** 最近一次采到网络事件的时间（0 = 还没采到），供 `idleMs()` 判断页面是否空闲 */
  let lastEventAt = 0;

  /**
   * 单条请求的元信息上限。
   *
   * 登录会话可长达数分钟、页面每秒都在发请求（实测 ~150 请求/16 秒），
   * 不设上限会让两个 Map 无界增长。超出后按插入顺序丢弃最旧的条目：
   * 被丢掉的都是早已归置完毕的历史请求，不影响后续采集。
   */
  const REQUEST_META_LIMIT = 4_000;
  const trimMaps = (): void => {
    while (requestMeta.size > REQUEST_META_LIMIT) {
      const oldest = requestMeta.keys().next().value;
      if (oldest === undefined) break;
      requestMeta.delete(oldest);
    }
    while (cookieByRequest.size > REQUEST_META_LIMIT) {
      const oldest = cookieByRequest.keys().next().value;
      if (oldest === undefined) break;
      cookieByRequest.delete(oldest);
    }
  };

  /** 两个事件到齐后归置；缺任一半就等对方到达时再补一次 */
  const place = (requestId: string): void => {
    const meta = requestMeta.get(requestId);
    const cookie = cookieByRequest.get(requestId);
    if (!meta || !cookie || !meta.host) return;
    if (meta.type === 'XHR' || meta.type === 'Fetch') byHost.set(meta.host, cookie);
    else if (!fallbackByHost.has(meta.host)) fallbackByHost.set(meta.host, cookie);
  };

  const offMain = browser.on('Network.requestWillBeSent', (params, sid) => {
    if (sid !== sessionId) return;
    const request = params.request;
    if (!request || typeof request !== 'object') return;
    const record = request as Record<string, unknown>;
    const url = typeof record.url === 'string' ? record.url : '';
    const requestId = typeof params.requestId === 'string' ? params.requestId : '';
    if (!requestId) return;
    lastEventAt = Date.now();
    let path = '';
    try {
      path = new URL(url).pathname;
    } catch {
      path = '';
    }
    requestMeta.set(requestId, {
      host: hostOf(url),
      path,
      type: typeof params.type === 'string' ? params.type : '',
    });
    trimMaps();
    // Cookie 可能先于本条到达（E 先到 14 次）：到齐即归置
    place(requestId);
  });

  const offExtra = browser.on('Network.requestWillBeSentExtraInfo', (params, sid) => {
    if (sid !== sessionId) return;
    const headers = params.headers;
    if (!headers || typeof headers !== 'object') return;
    const cookie = cookieOfHeaders(headers);
    const requestId = typeof params.requestId === 'string' ? params.requestId : '';
    if (!cookie || !requestId) return;
    lastEventAt = Date.now();
    cookieByRequest.set(requestId, cookie);
    trimMaps();
    // requestWillBeSent 已到且 host 可用 → 直接归置；否则用 associatedCookies 的域做兜底归属，
    // 等 requestWillBeSent 到达时 place() 会用更准的 url 覆盖主池
    const known = requestMeta.get(requestId);
    if (known?.host) {
      place(requestId);
      return;
    }
    const domain = domainOfAssociatedCookies(params.associatedCookies);
    if (domain && !fallbackByHost.has(domain)) fallbackByHost.set(domain, cookie);
  });

  // 记录「页面自己请求成功」的地址：登录态下身份接口 200、访客态 401，
  // 这条功能性证据不依赖 Cookie 名，站点/上游改版时仍成立
  const offResponse = browser.on('Network.responseReceived', (params, sid) => {
    if (sid !== sessionId) return;
    const requestId = typeof params.requestId === 'string' ? params.requestId : '';
    const status = (params.response as { status?: unknown } | undefined)?.status;
    if (!requestId || typeof status !== 'number') return;
    lastEventAt = Date.now();
    const meta = requestMeta.get(requestId);
    if (meta && meta.path && status >= 200 && status < 300) successPaths.add(meta.path);
  });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    offMain();
    offExtra();
    offResponse();
    try {
      await browser.send('Target.closeTarget', { targetId }, undefined, 2_000);
    } catch {
      // 标签页可能已被用户关掉
    }
    browser.close();
  };

  try {
    await browser.send('Network.enable', {}, sessionId, timeoutMs);
    await browser.send('Page.enable', {}, sessionId, timeoutMs);
    // 标签页已按 url 打开；这里再显式导航一次，确保 Network.enable 之后能收到请求
    await browser.send('Page.navigate', { url: options.url }, sessionId, timeoutMs);
  } catch (error) {
    await close();
    throw error;
  }

  /** 查 Cookie 头：先查 xhr/fetch 池，再查兜底池（两个池共用同一匹配规则） */
  const findCookie = (sites: string[]): string | null => {
    for (const host of byHost.keys()) {
      if (sites.some((site) => hostMatches(host, site))) return byHost.get(host) ?? null;
    }
    for (const host of fallbackByHost.keys()) {
      if (sites.some((site) => hostMatches(host, site))) return fallbackByHost.get(host) ?? null;
    }
    return null;
  };

  /**
   * 在页面上下文执行一次取值表达式（只读，`returnByValue`）。
   *
   * 页面导航 / 权限限制 / 执行上下文销毁都会让 `Runtime.evaluate` 失败：
   * 对登录轮询来说这只是「还没好」，返回 undefined 交给上层继续等待，
   * 不把一次瞬时失败升级成登录失败。
   */
  const evaluateValue = async (expression: string): Promise<unknown> => {
    if (closed) return undefined;
    try {
      const outcome = (await browser.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        sessionId,
        timeoutMs,
      )) as { result?: { value?: unknown }; exceptionDetails?: unknown };
      if (outcome?.exceptionDetails) return undefined;
      return outcome?.result?.value;
    } catch {
      return undefined;
    }
  };

  const localStorageValue = async (key: string): Promise<string> => {
    const raw = await evaluateValue(
      `(() => { try { return localStorage.getItem(${JSON.stringify(key)}) ?? ''; } catch { return ''; } })()`,
    );
    return typeof raw === 'string' ? raw : '';
  };

  return {
    cookieFor: findCookie,
    // 刻意不通过 `this.cookieFor` 调用：解构取用（const { cookieFor } = collector）时 this 会丢
    cookieNamesFor(sites: string[]): string[] {
      const header = findCookie(sites);
      return header ? cookieNamesOf(header) : [];
    },
    sawSuccessfulRequest(pathSuffix: string): boolean {
      // 精确匹配 pathname：用 endsWith 会把 `/x/api/v1/me` 甚至无关后缀也算命中，
      // 而这条判据是「登录成功」的门禁，宁可严格。
      return successPaths.has(pathSuffix);
    },
    idleMs(): number {
      return lastEventAt === 0 ? 0 : Date.now() - lastEventAt;
    },
    async reload(): Promise<void> {
      if (closed) return;
      try {
        await browser.send('Page.reload', {}, sessionId, timeoutMs);
      } catch {
        // 刷新失败不致命：下一轮轮询还会再试
      }
    },
    localStorageItem: localStorageValue,
    async localStorageObject(key: string): Promise<Record<string, unknown> | null> {
      const raw = await localStorageValue(key);
      if (!raw) return null;
      try {
        const parsed: unknown = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      } catch {
        return null;
      }
    },
    close,
  };
}
