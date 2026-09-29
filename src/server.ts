import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { describeRegistry } from './providers/index.js';
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
    })),
  };
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
  if (!service.accounts.some((account) => account.enabled && !account.provider.startsWith('demo:'))) {
    console.log('  提示：当前只有示例数据，配置真实凭证请编辑 accounts.json（保存后自动生效）\n');
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
