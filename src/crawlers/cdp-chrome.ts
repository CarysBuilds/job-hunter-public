import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { hasExpiredJobSignal, JobUnavailableError } from './availability.js';
import type { CrawlConfig, JobSource } from '../types.js';

const execFileAsync = promisify(execFile);

interface CdpVersion {
  webSocketDebuggerUrl: string;
}

interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export interface BrowserFetchResult<T = unknown> {
  status: number;
  ok: boolean;
  data: T;
}

export interface PlatformCdpOptions {
  source: JobSource;
  label: string;
  loginUrl: string;
  homeUrl: string;
  profileDirName: string;
  markerFileName: string;
  targetUrlPattern: RegExp;
  preferredTargetUrlPattern?: RegExp;
  authUrlPattern: RegExp;
}

export const PLATFORM_CDP_OPTIONS: Record<JobSource, PlatformCdpOptions> = {
  boss: {
    source: 'boss',
    label: 'BOSS',
    loginUrl: 'https://www.zhipin.com/web/user/',
    homeUrl: 'https://www.zhipin.com/',
    profileDirName: 'boss-chrome-profile',
    markerFileName: 'boss-cdp.json',
    targetUrlPattern: /^https:\/\/www\.zhipin\.com\//,
    preferredTargetUrlPattern: /\/web\/geek\/|\/job_detail\//,
    authUrlPattern: /\/web\/user\/|security-check|verify/i,
  },
  liepin: {
    source: 'liepin',
    label: '猎聘',
    loginUrl: 'https://passport.liepin.com/login/',
    homeUrl: 'https://www.liepin.com/',
    profileDirName: 'liepin-chrome-profile',
    markerFileName: 'liepin-cdp.json',
    targetUrlPattern: /^https:\/\/([^/]+\.)?liepin\.com\//,
    preferredTargetUrlPattern: /\/zhaopin\/|\/job\/|\/a\/\d+\.shtml/i,
    authUrlPattern: /passport\.liepin\.com|\/login|security|verify|captcha/i,
  },
  zhaopin: {
    source: 'zhaopin',
    label: '智联',
    loginUrl: 'https://passport.zhaopin.com/',
    homeUrl: 'https://www.zhaopin.com/',
    profileDirName: 'zhaopin-chrome-profile',
    markerFileName: 'zhaopin-cdp.json',
    targetUrlPattern: /^https:\/\/([^/]+\.)?zhaopin\.com\//,
    preferredTargetUrlPattern: /sou\.zhaopin\.com|\/jobs\/|\/jobdetail/i,
    authUrlPattern: /passport\.zhaopin\.com|\/login|security|verify|captcha/i,
  },
};

function chromeArgs(port: number, profileDir: string, url: string): string[] {
  return [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    url,
  ];
}

function findWindowsChrome(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.LOCALAPPDATA && resolve(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.PROGRAMFILES && resolve(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && resolve(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean) as string[];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function launchChrome(port: number, profileDir: string, url: string): Promise<void> {
  const args = chromeArgs(port, profileDir, url);
  if (process.platform === 'darwin') {
    await execFileAsync('/usr/bin/open', ['-na', 'Google Chrome', '--args', ...args]);
    return;
  }
  if (process.platform === 'win32') {
    const chrome = findWindowsChrome();
    if (!chrome) throw new Error('未找到 Google Chrome，请先安装 Chrome，或设置 CHROME_PATH 指向 chrome.exe');
    const child = spawn(chrome, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return;
  }
  const child = spawn(process.env.CHROME_PATH || 'google-chrome', args, { detached: true, stdio: 'ignore' });
  child.unref();
}

export class CdpChromeSession {
  private readonly port: number;
  private readonly origin: string;
  private readonly profileDir: string;
  private readonly markerPath: string;
  private activeTargetId?: string;

  constructor(
    private readonly config: CrawlConfig,
    private readonly options: PlatformCdpOptions = PLATFORM_CDP_OPTIONS.boss
  ) {
    this.port = config.cdpPorts?.[options.source] ?? config.cdpPort;
    this.origin = `http://127.0.0.1:${this.port}`;
    this.profileDir = resolve(config.authDir, options.profileDirName);
    this.markerPath = join(config.authDir, options.markerFileName);
  }

  async ensureOpen(url = this.options.homeUrl): Promise<void> {
    if (!(await this.probe())) {
      await mkdir(this.profileDir, { recursive: true });
      await launchChrome(this.port, this.profileDir, url);
      for (let attempt = 0; attempt < 30; attempt++) {
        if (await this.probe()) break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      }
      if (!(await this.probe())) throw new Error(`Chrome CDP 未能在端口 ${this.port} 启动`);
    }
    if (!(await this.findTarget())) await this.openTarget(url);
  }

  async openLogin(): Promise<void> {
    await this.ensureOpen(this.options.loginUrl);
    const target = await this.findTarget();
    if (target && !this.options.authUrlPattern.test(target.url)) {
      await this.command(target.webSocketDebuggerUrl, 'Page.navigate', { url: this.options.loginUrl });
    }
  }

  async isLoggedIn(): Promise<boolean> {
    const result = await this.fetchJson<{ code?: number }>('/wapi/zpuser/wap/getUserInfo.json');
    return result.ok && result.data?.code === 0;
  }

  async saveMarker(): Promise<void> {
    await mkdir(this.config.authDir, { recursive: true });
    await writeFile(this.markerPath, JSON.stringify({
      mode: 'chrome-cdp',
      source: this.options.source,
      port: this.port,
      profileDir: this.profileDir,
      savedAt: new Date().toISOString(),
    }, null, 2), 'utf-8');
  }

  async warmHome(): Promise<void> {
    await this.ensureOpen();
    const target = await this.findTarget();
    if (!target) throw new Error(`Chrome 中没有可用的 ${this.options.label} 页面`);
    await this.command(target.webSocketDebuggerUrl, 'Page.navigate', { url: this.options.homeUrl });
    // Page.navigate 只确认导航已发起；招聘站点的安全运行时会在 DOM 加载后继续生成会话令牌。
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 6_000));
  }

  async currentUrl(): Promise<string | undefined> {
    await this.ensureOpen();
    return (await this.findTarget())?.url;
  }

  async navigate(pageUrl: string): Promise<void> {
    await this.ensureOpen(pageUrl);
    const target = await this.findTarget();
    if (!target) throw new Error(`Chrome 中没有可用的 ${this.options.label} 页面`);
    this.activeTargetId = target.id;
    await this.command(target.webSocketDebuggerUrl, 'Page.navigate', { url: pageUrl });
  }

  async evaluateCurrent<T>(expression: string): Promise<T> {
    const target = await this.activeOrPlatformTarget();
    if (!target) throw new Error(`Chrome 中没有可用的 ${this.options.label} 页面`);
    const value = await this.evaluate<{ value: T; url: string }>(
      target.webSocketDebuggerUrl,
      `(async () => ({ value: await (${expression}), url: location.href }))()`
    );
    if (this.options.authUrlPattern.test(value.url)) {
      throw new Error(`${this.options.label} 页面跳转到登录或安全验证`);
    }
    return value.value;
  }

  async insertText(text: string): Promise<void> {
    const target = await this.activeOrPlatformTarget();
    if (!target) throw new Error(`Chrome 中没有可用的 ${this.options.label} 页面`);
    await this.command(target.webSocketDebuggerUrl, 'Input.insertText', { text });
  }

  async pressEnter(): Promise<void> {
    const target = await this.activeOrPlatformTarget();
    if (!target) throw new Error(`Chrome 中没有可用的 ${this.options.label} 页面`);
    const keyEvent = {
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    };
    await this.command(target.webSocketDebuggerUrl, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...keyEvent });
    await this.command(target.webSocketDebuggerUrl, 'Input.dispatchKeyEvent', { type: 'keyUp', ...keyEvent });
  }

  async fetchJson<T>(path: string, params: Record<string, string | number> = {}): Promise<BrowserFetchResult<T>> {
    await this.ensureOpen();
    const target = await this.findTarget();
    if (!target) throw new Error(`Chrome 中没有可用的 ${this.options.label} 页面`);
    const absoluteUrl = new URL(path, this.options.homeUrl);
    for (const [key, value] of Object.entries(params)) absoluteUrl.searchParams.set(key, String(value));
    const expression = `(async () => {
      try {
        const url = new URL(${JSON.stringify(absoluteUrl.toString())});
        const response = await fetch(url.toString(), {
          method: 'GET', credentials: 'include',
          headers: { 'Accept': 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest' }
        });
        const text = await response.text();
        let data;
        try { data = JSON.parse(text); } catch { data = { code: -1, message: text.slice(0, 300) }; }
        return { status: response.status, ok: response.ok, data };
      } catch (error) {
        return { status: 0, ok: false, data: { code: -1, message: String(error) } };
      }
    })()`;
    return this.evaluate<BrowserFetchResult<T>>(target.webSocketDebuggerUrl, expression);
  }

  /**
   * 让招聘站点官方页面自己构造请求，并捕获指定接口的 JSON 响应。
   * 动态 token、traceId 始终留在 Chrome 页面内部。
   */
  async navigateAndCaptureJson<T>(pageUrl: string, responsePath: string, timeoutMs = 30_000): Promise<BrowserFetchResult<T>> {
    await this.ensureOpen(pageUrl);
    const target = await this.findTarget();
    if (!target) throw new Error(`Chrome 中没有可用的 ${this.options.label} 页面`);

    return new Promise((resolvePromise, reject) => {
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
      let sequence = 0;
      let matchedRequestId = '';
      let matchedStatus = 0;
      let settled = false;
      const finish = (error?: Error, value?: BrowserFetchResult<T>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.close();
        if (error) reject(error);
        else resolvePromise(value!);
      };
      const send = (method: string, params: Record<string, unknown> = {}) => new Promise<unknown>((resolveCommand, rejectCommand) => {
        const id = ++sequence;
        pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
        socket.send(JSON.stringify({ id, method, params }));
      });
      const timer = setTimeout(() => finish(new Error(`等待 ${this.options.label} 官方接口 ${responsePath} 超时`)), timeoutMs);

      socket.onerror = () => finish(new Error('CDP 官方页面监听连接失败'));
      socket.onopen = async () => {
        try {
          await send('Network.enable');
          await send('Page.enable');
          await send('Page.navigate', { url: pageUrl });
        } catch (error) {
          finish(error as Error);
        }
      };
      socket.onmessage = async (event) => {
        const message = JSON.parse(String(event.data)) as {
          id?: number;
          result?: unknown;
          error?: { message?: string };
          method?: string;
          params?: Record<string, any>;
        };
        if (message.id && pending.has(message.id)) {
          const command = pending.get(message.id)!;
          pending.delete(message.id);
          if (message.error) command.reject(new Error(message.error.message || 'CDP 命令失败'));
          else command.resolve(message.result);
          return;
        }
        const params = message.params;
        if (message.method === 'Network.responseReceived' && params?.response?.url?.includes(responsePath)) {
          matchedRequestId = String(params.requestId);
          matchedStatus = Number(params.response.status);
          return;
        }
        if (message.method === 'Network.loadingFinished' && matchedRequestId && String(params?.requestId) === matchedRequestId) {
          try {
            const body = await send('Network.getResponseBody', { requestId: matchedRequestId }) as { body?: string; base64Encoded?: boolean };
            const text = body.base64Encoded
              ? Buffer.from(body.body ?? '', 'base64').toString('utf-8')
              : body.body ?? '';
            const data = JSON.parse(text) as T;
            finish(undefined, { status: matchedStatus, ok: matchedStatus >= 200 && matchedStatus < 300, data });
          } catch (error) {
            finish(new Error(`${this.options.label} 官方接口响应无法解析：${(error as Error).message}`));
          }
        }
      };
    });
  }

  async navigateAndExtractText(pageUrl: string, selectors: string[], timeoutMs = 20_000): Promise<string> {
    await this.ensureOpen(pageUrl);
    const target = await this.findTarget();
    if (!target) throw new Error(`Chrome 中没有可用的 ${this.options.label} 页面`);
    await this.command(target.webSocketDebuggerUrl, 'Page.navigate', { url: pageUrl });
    const started = Date.now();
    const expectedPath = new URL(pageUrl).pathname;
    const expression = `(() => {
      const selectors = ${JSON.stringify(selectors)};
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        const text = element?.innerText?.trim();
        if (text) return { text, url: location.href, bodyText: document.body?.innerText || '' };
      }
      return { text: '', url: location.href, bodyText: document.body?.innerText || '' };
    })()`;
    while (Date.now() - started < timeoutMs) {
      const result = await this.evaluate<{ text: string; url: string; bodyText: string }>(target.webSocketDebuggerUrl, expression);
      if (this.options.authUrlPattern.test(result.url)) {
        throw new Error(`${this.options.label} 页面跳转到登录或安全验证`);
      }
      if (hasExpiredJobSignal(result.bodyText)) {
        throw new JobUnavailableError(`${this.options.label} 详情页显示岗位已失效或招聘已结束`);
      }
      if (result.text && new URL(result.url).pathname === expectedPath) return result.text;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    return '';
  }

  async navigateAndEvaluate<T>(pageUrl: string, expression: string, timeoutMs = 20_000): Promise<T> {
    await this.ensureOpen(pageUrl);
    const target = await this.findTarget();
    if (!target) throw new Error(`Chrome 中没有可用的 ${this.options.label} 页面`);
    await this.command(target.webSocketDebuggerUrl, 'Page.navigate', { url: pageUrl });
    const started = Date.now();
    let lastValue: T | undefined;
    const wrapped = `(async () => {
      const value = await (${expression});
      return { value, url: location.href, readyState: document.readyState };
    })()`;
    while (Date.now() - started < timeoutMs) {
      const result = await this.evaluate<{ value: T; url: string; readyState: string }>(target.webSocketDebuggerUrl, wrapped);
      if (this.options.authUrlPattern.test(result.url)) {
        throw new Error(`${this.options.label} 页面跳转到登录或安全验证`);
      }
      lastValue = result.value;
      if (this.hasUsefulValue(result.value)) return result.value;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    return lastValue as T;
  }

  private async probe(): Promise<boolean> {
    try {
      const response = await fetch(`${this.origin}/json/version`, { signal: AbortSignal.timeout(800) });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async targets(): Promise<CdpTarget[]> {
    const response = await fetch(`${this.origin}/json/list`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) throw new Error(`CDP 标签页查询失败：HTTP ${response.status}`);
    return response.json() as Promise<CdpTarget[]>;
  }

  private async findTarget(): Promise<CdpTarget | undefined> {
    const pages = (await this.targets()).filter(
      (target) => target.type === 'page' && this.options.targetUrlPattern.test(target.url)
    );
    return this.options.preferredTargetUrlPattern
      ? pages.find((target) => this.options.preferredTargetUrlPattern!.test(target.url)) ?? pages[0]
      : pages[0];
  }

  private async findActiveTarget(): Promise<CdpTarget | undefined> {
    if (!this.activeTargetId) return undefined;
    try {
      return (await this.targets()).find(
        (target) => target.id === this.activeTargetId && target.type === 'page' && Boolean(target.webSocketDebuggerUrl)
      );
    } catch {
      return undefined;
    }
  }

  private async activeOrPlatformTarget(): Promise<CdpTarget | undefined> {
    const active = await this.findActiveTarget();
    if (active) return active;
    await this.ensureOpen();
    const target = await this.findTarget();
    if (target) this.activeTargetId = target.id;
    return target;
  }

  private async openTarget(url: string): Promise<void> {
    const response = await fetch(`${this.origin}/json/new?${encodeURIComponent(url)}`, {
      method: 'PUT', signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error(`无法在 Chrome 中打开 ${this.options.label} 页面：HTTP ${response.status}`);
  }

  private async evaluate<T>(webSocketUrl: string, expression: string): Promise<T> {
    const response = await this.command(webSocketUrl, 'Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    }) as { result?: { value?: T }; exceptionDetails?: { text?: string } };
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'CDP 页面执行失败');
    if (!response.result || !('value' in response.result)) throw new Error('CDP 页面未返回结果');
    return response.result.value as T;
  }

  private hasUsefulValue(value: unknown): boolean {
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'string') return value.trim().length > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return value !== null && value !== undefined && value !== false;
  }

  private command(webSocketUrl: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolvePromise, reject) => {
      const socket = new WebSocket(webSocketUrl);
      const id = Math.floor(Math.random() * 1_000_000_000);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`CDP ${method} 超时`));
      }, 20_000);
      socket.onopen = () => socket.send(JSON.stringify({ id, method, params }));
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`CDP ${method} 连接失败`));
      };
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message?: string } };
        if (message.id !== id) return;
        clearTimeout(timer);
        socket.close();
        if (message.error) reject(new Error(message.error.message || `CDP ${method} 失败`));
        else resolvePromise(message.result);
      };
    });
  }
}
