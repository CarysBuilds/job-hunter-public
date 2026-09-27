import { getCrawlConfig } from '../config.js';
import { CdpChromeSession, PLATFORM_CDP_OPTIONS } from '../crawlers/cdp-chrome.js';
import type { JobSource, ScoredJob } from '../types.js';

export interface GreetingSendResult {
  platform: JobSource;
  sentAt: string;
  receiptConfirmed: true;
  confirmationMethod: 'outgoing_message_bubble' | 'test';
  details?: string;
}

export interface GreetingSender {
  status?(): { enabled: boolean; label: string };
  send(job: ScoredJob, message: string): Promise<GreetingSendResult>;
}

export class GreetingSendDisabledError extends Error {
  constructor() {
    super('BOSS 发送未启用');
    this.name = 'GreetingSendDisabledError';
  }
}

export class BossJobUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BossJobUnavailableError';
  }
}

export class GreetingReceiptUnknownError extends Error {
  constructor(message = '平台发送动作已触发，但未能确认消息回执；为避免重复发送，已停止自动重试') {
    super(message);
    this.name = 'GreetingReceiptUnknownError';
  }
}

export interface BossGreetingBrowserSession {
  navigate(pageUrl: string): Promise<void>;
  evaluateCurrent<T>(expression: string): Promise<T>;
  insertText(text: string): Promise<void>;
}

interface BossGreetingSenderOptions {
  enabled?: boolean;
  sessionFactory?: () => BossGreetingBrowserSession;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

interface BossGreetingEvaluateResult {
  ok?: boolean;
  receiptConfirmed?: boolean;
  action?: 'insertText' | 'clickSend';
  actionStarted?: boolean;
  unavailable?: boolean;
  uncertain?: boolean;
  error?: string;
  details?: string;
}

const BOSS_GREETING_BUTTON_SELECTORS = [
  '.btn-startchat',
  '.op-btn-chat',
  '.start-chat-btn',
  '.job-op .btn',
  '.job-banner .btn',
  'a[href*="/web/geek/chat"]',
  'button',
  'a',
];

const BOSS_MESSAGE_INPUT_SELECTORS = [
  '#chat-input',
  '.chat-input[contenteditable="true"]',
  '.chat-editor [contenteditable="true"]',
  '.editor [contenteditable="true"]',
  'textarea',
  '[contenteditable="true"]',
  '.chat-input textarea',
  '.input-area textarea',
  '.message-input textarea',
];

const BOSS_SEND_BUTTON_SELECTORS = [
  'button[type="send"]',
  '.btn-send',
  '.btn-sure-v2',
  '.send-btn',
  '.chat-send',
  '[class*="send"]',
  '[aria-label*="发送"]',
  '[title*="发送"]',
  'button',
  'a',
];

export function bossGreetingExpression(message: string, expectedUrl = ''): string {
  return `(() => {
    const message = ${JSON.stringify(message)};
    const expectedUrl = ${JSON.stringify(expectedUrl)};
    const contactSelectors = ${JSON.stringify(BOSS_GREETING_BUTTON_SELECTORS)};
    const inputSelectors = ${JSON.stringify(BOSS_MESSAGE_INPUT_SELECTORS)};
    const sendSelectors = ${JSON.stringify(BOSS_SEND_BUTTON_SELECTORS)};
    const now = Date.now();
    if (!window.__jobHunterGreeting || window.__jobHunterGreeting.message !== message || window.__jobHunterGreeting.expectedUrl !== expectedUrl || now - window.__jobHunterGreeting.startedAt > 60000) {
      window.__jobHunterGreeting = {
        message,
        expectedUrl,
        entryVerified: false,
        startedAt: now,
        clicked: false,
        fillRequested: false,
        fillRequestedAt: 0,
        domFillTried: false,
        filled: false,
        sendReadyWaitStartedAt: 0,
        sendRequested: false,
        sendRequestedAt: 0,
        receiptBaseline: 0,
      };
    }
    const state = window.__jobHunterGreeting;
    const elapsed = now - state.startedAt;
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const bodyText = normalize([document.title, document.body?.innerText].filter(Boolean).join(' '));
    const authUrlPattern = /login|passport|security-check|verify|captcha|safe/i;
    const authTextPattern = /\\b(?:log\\s*in|sign\\s*in|passport|security[\\s-]*check|captcha)\\b|请(?:先)?登录|登录后继续|安全验证|验证码|完成验证/i;
    if (authUrlPattern.test(location.href) || authTextPattern.test(bodyText)) {
      return { ok: false, error: 'BOSS 页面进入登录、安全验证或验证码状态' };
    }
    const normalizedMessage = normalize(message);
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const disabled = (element) => Boolean(
      element.disabled
      || element.getAttribute('aria-disabled') === 'true'
      || /\\bdisabled\\b/i.test(element.className || '')
      || getComputedStyle(element).pointerEvents === 'none'
    );
    const enabled = (element) => !disabled(element);
    const candidates = (selectors, allowDisabled = false) => selectors.flatMap((selector) => [...document.querySelectorAll(selector)])
      .filter((element, index, array) => array.indexOf(element) === index)
      .filter((element) => visible(element) && (allowDisabled || enabled(element)));
    const byText = (elements, patterns) => elements.find((element) => {
      const text = normalize([
        element.innerText,
        element.textContent,
        element.value,
        element.getAttribute?.('aria-label'),
        element.getAttribute?.('title'),
        element.className,
      ].filter(Boolean).join(' '));
      return patterns.some((pattern) => pattern.test(text));
    });
    const brief = (element) => {
      if (!element) return 'none';
      const rect = element.getBoundingClientRect();
      return [
        element.tagName.toLowerCase(),
        element.id ? '#' + element.id : '',
        element.className ? '.' + String(element.className).replace(/\\s+/g, '.') : '',
        'text=' + normalize(element.innerText || element.textContent || element.value).slice(0, 40),
        'disabled=' + disabled(element),
        'rect=' + Math.round(rect.x) + ',' + Math.round(rect.y) + ',' + Math.round(rect.width) + 'x' + Math.round(rect.height),
      ].filter(Boolean).join(' ');
    };
    const diagnostics = () => {
      const inputSummary = candidates(inputSelectors, true).map(brief).slice(0, 4).join(' | ');
      const sendSummary = candidates(sendSelectors, true).filter((element) => byText([element], [/发送/, /Send/i])).map(brief).slice(0, 6).join(' | ');
      return 'url=' + location.href + '; input=' + (inputSummary || 'none') + '; send=' + (sendSummary || 'none');
    };
    const expectedPath = (() => {
      try { return expectedUrl ? new URL(expectedUrl).pathname : ''; } catch { return ''; }
    })();
    if (expectedPath) {
      if (location.hostname !== 'www.zhipin.com') return { ok: false, error: '页面不属于 BOSS，已停止发送' };
      if (!state.entryVerified) {
        if (location.pathname !== expectedPath || document.readyState !== 'complete') {
          if (elapsed < 12000) return false;
          return { ok: false, error: '未能核对目标岗位页面，已停止发送' };
        }
        state.entryVerified = true;
      }
      if (/\\/job_detail\\//.test(location.pathname) && location.pathname !== expectedPath) {
        return { ok: false, error: '当前岗位与选中岗位不同，已停止发送' };
      }
    }
    const unavailablePattern = /您访问的页面不存在|页面不存在|职位不存在|岗位不存在|职位已下线|岗位已下线|职位已关闭|岗位已关闭|招聘已结束|404/i;
    const onBossHome = location.hostname === 'www.zhipin.com' && (location.pathname === '/' || location.pathname === '');
    const expectedJobDetail = /\\/job_detail\\//.test(expectedPath);
    if (unavailablePattern.test(bodyText) || (expectedJobDetail && onBossHome && elapsed > 5000)) {
      return { ok: false, unavailable: true, error: 'BOSS 岗位已失效或不可访问', details: diagnostics() };
    }
    const click = (element) => {
      element.scrollIntoView({ block: 'center', inline: 'center' });
      element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      element.click();
    };
    const focusInput = (input) => {
      input.scrollIntoView({ block: 'center', inline: 'center' });
      input.focus();
    };
    const inputText = (input) => normalize(input.isContentEditable ? input.innerText || input.textContent : input.value);
    const receiptMatches = () => {
      const selectors = [
        '.message-item.item-myself',
        '.message-item.myself',
        '.chat-message-item.myself',
        '.message-item.is-self',
        '[data-from="self"]',
        '[data-sender="self"]',
      ];
      return selectors.flatMap((selector) => [...document.querySelectorAll(selector)])
        .filter((element, index, array) => array.indexOf(element) === index)
        .filter((element) => visible(element))
        .filter((element) => normalize(element.innerText || element.textContent).includes(normalizedMessage));
    };
    if (state.sendRequested) {
      const matches = receiptMatches();
      if (matches.length > state.receiptBaseline) {
        delete window.__jobHunterGreeting;
        return { ok: true, receiptConfirmed: true, details: '已观察到新增的本人消息气泡' };
      }
      if (now - state.sendRequestedAt > 12000) {
        delete window.__jobHunterGreeting;
        return { ok: false, uncertain: true, error: 'BOSS 发送回执未确认', details: diagnostics() };
      }
      return false;
    }
    const dispatchTextEvents = (input, data) => {
      try {
        input.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'insertText',
          data,
        }));
      } catch {
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: data ? data[data.length - 1] : 'Backspace' }));
    };
    const clearInput = (input) => {
      focusInput(input);
      if (input.isContentEditable) {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(input);
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand('delete', false);
        if (inputText(input)) input.textContent = '';
      } else {
        const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
        if (descriptor?.set) descriptor.set.call(input, '');
        else input.value = '';
      }
      dispatchTextEvents(input, '');
    };
    const domFill = (input) => {
      clearInput(input);
      if (input.isContentEditable) {
        document.execCommand('insertText', false, message);
        if (inputText(input) !== normalizedMessage) input.textContent = message;
      } else {
        const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
        if (descriptor?.set) descriptor.set.call(input, message);
        else input.value = message;
      }
      dispatchTextEvents(input, message);
    };
    const findInput = () => candidates(inputSelectors)[0];
    if (!state.clicked) {
      if (findInput()) {
        state.clicked = true;
      } else {
        const button = byText(candidates(contactSelectors), [/立即沟通/, /继续沟通/, /打招呼/, /沟通/, /聊一聊/, /立即聊/]);
        if (button) {
          click(button);
          state.clicked = true;
          return false;
        }
        if (elapsed < 12000) return false;
        return { ok: false, error: '未找到 BOSS 沟通入口', details: diagnostics() };
      }
    }
    const input = findInput();
    if (!input) {
      if (elapsed < 22000) return false;
      return { ok: false, error: '未找到 BOSS 消息输入框', details: diagnostics() };
    }
    const currentText = inputText(input);
    if (state.filled && currentText !== normalizedMessage) {
      delete window.__jobHunterGreeting;
      return { ok: false, error: 'BOSS 消息输入框内容在发送前发生变化，未执行发送动作', details: diagnostics() };
    }
    if (!state.filled && currentText !== normalizedMessage) {
      focusInput(input);
      if (!state.fillRequested) {
        clearInput(input);
        state.fillRequested = true;
        state.fillRequestedAt = now;
        return { ok: false, action: 'insertText', details: 'BOSS 输入框已聚焦，等待 Chrome 插入文本' };
      }
      if (!state.domFillTried && now - state.fillRequestedAt > 1200) {
        state.domFillTried = true;
        domFill(input);
        return false;
      }
      if (elapsed < 28000) return false;
      return { ok: false, error: 'BOSS 消息输入框未能写入内容', details: diagnostics() };
    }
    if (!state.filled) {
      state.filled = true;
      state.sendReadyWaitStartedAt = now;
      // CDP Input.insertText 能更新 contenteditable 文本，但 BOSS 的页面状态不一定同步更新。
      // 再发送一次输入事件并等待按钮解锁；此时仍未执行任何发送动作。
      dispatchTextEvents(input, currentText);
      return false;
    }
    const sendButtons = candidates(sendSelectors, true).filter((element) => byText([element], [/发送/, /Send/i]));
    const send = sendButtons.find((element) => enabled(element));
    if (send) {
      return { ok: false, action: 'clickSend', details: 'BOSS 发送按钮已就绪，等待执行发送动作' };
    }
    if (now - state.sendReadyWaitStartedAt < 3000) return false;
    delete window.__jobHunterGreeting;
    return { ok: false, error: 'BOSS 消息已写入，但发送按钮未启用；未执行发送动作', details: diagnostics() };
  })()`;
}

/**
 * 单独执行发送按钮点击，使调用方能明确划分“只读准备检查”和“可能已经发送”的边界。
 * 该表达式一旦发给 Chrome 执行，若 CDP 响应丢失，调用方必须按回执未知处理。
 */
export function bossGreetingClickExpression(message: string): string {
  return `(() => {
    const message = ${JSON.stringify(message)};
    const inputSelectors = ${JSON.stringify(BOSS_MESSAGE_INPUT_SELECTORS)};
    const sendSelectors = ${JSON.stringify(BOSS_SEND_BUTTON_SELECTORS)};
    const state = window.__jobHunterGreeting;
    if (!state || state.message !== message || !state.filled) {
      return { ok: false, error: 'BOSS 发送准备状态已失效，未执行点击' };
    }
    if (state.expectedUrl && (!state.entryVerified || location.hostname !== 'www.zhipin.com'
      || (/\\/job_detail\\//.test(location.pathname) && location.pathname !== new URL(state.expectedUrl).pathname))) {
      return { ok: false, error: '发送前目标岗位核对失败，未执行点击' };
    }
    if (state.sendRequested) return { ok: false, actionStarted: true };
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const disabled = (element) => Boolean(
      element.disabled
      || element.getAttribute('aria-disabled') === 'true'
      || /\\bdisabled\\b/i.test(element.className || '')
      || getComputedStyle(element).pointerEvents === 'none'
    );
    const candidates = (selectors) => selectors.flatMap((selector) => [...document.querySelectorAll(selector)])
      .filter((element, index, array) => array.indexOf(element) === index)
      .filter((element) => visible(element) && !disabled(element));
    const byText = (elements, patterns) => elements.find((element) => {
      const text = normalize([
        element.innerText,
        element.textContent,
        element.value,
        element.getAttribute?.('aria-label'),
        element.getAttribute?.('title'),
        element.className,
      ].filter(Boolean).join(' '));
      return patterns.some((pattern) => pattern.test(text));
    });
    const input = inputSelectors.flatMap((selector) => [...document.querySelectorAll(selector)])
      .filter((element, index, array) => array.indexOf(element) === index)
      .find((element) => visible(element));
    const inputText = input
      ? normalize(input.isContentEditable ? input.innerText || input.textContent : input.value)
      : '';
    if (!input || inputText !== normalize(message)) {
      return { ok: false, error: 'BOSS 消息输入框内容在点击发送前发生变化，未执行点击' };
    }
    const receiptMatches = () => {
      const selectors = [
        '.message-item.item-myself',
        '.message-item.myself',
        '.chat-message-item.myself',
        '.message-item.is-self',
        '[data-from="self"]',
        '[data-sender="self"]',
      ];
      return selectors.flatMap((selector) => [...document.querySelectorAll(selector)])
        .filter((element, index, array) => array.indexOf(element) === index)
        .filter((element) => visible(element))
        .filter((element) => normalize(element.innerText || element.textContent).includes(normalize(message)));
    };
    const send = byText(candidates(sendSelectors), [/发送/, /Send/i]);
    if (!send) return { ok: false, error: 'BOSS 发送按钮在执行前已失效，未执行点击' };
    state.receiptBaseline = receiptMatches().length;
    state.sendRequested = true;
    state.sendRequestedAt = Date.now();
    send.scrollIntoView({ block: 'center', inline: 'center' });
    send.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    send.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    send.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    send.click();
    return { ok: false, actionStarted: true };
  })()`;
}

function unknownReceiptError(error?: unknown): GreetingReceiptUnknownError {
  const detail = error instanceof Error ? error.message : error ? String(error) : '';
  return new GreetingReceiptUnknownError(
    detail
      ? `平台发送动作可能已触发，但未能确认消息回执；为避免重复发送，已停止自动重试：${detail}`
      : undefined
  );
}

export class BossGreetingSender implements GreetingSender {
  constructor(private readonly options: BossGreetingSenderOptions = {}) {}

  status() {
    return {
      enabled: this.options.enabled ?? true,
      label: 'BOSS',
    };
  }

  async send(job: ScoredJob, message: string): Promise<GreetingSendResult> {
    if (!this.status().enabled) throw new GreetingSendDisabledError();
    if (job.source !== 'boss') throw new Error('自动发送第一版只支持 BOSS 岗位');
    const url = new URL(job.url);
    if (url.protocol !== 'https:' || url.hostname !== 'www.zhipin.com' || !/^\/job_detail\/[^/]+\.html$/.test(url.pathname) || url.username || url.password || url.port) throw new Error('岗位缺少有效的 BOSS 详情链接');
    const session = this.options.sessionFactory?.()
      ?? new CdpChromeSession(getCrawlConfig({ pages: 1 }), PLATFORM_CDP_OPTIONS.boss);
    await session.navigate(job.url);
    const started = Date.now();
    const timeoutMs = this.options.timeoutMs ?? 45_000;
    const pollIntervalMs = this.options.pollIntervalMs ?? 500;
    let sendActionMayHaveOccurred = false;
    let result: BossGreetingEvaluateResult | undefined;
    while (Date.now() - started < timeoutMs) {
      try {
        result = await session.evaluateCurrent<BossGreetingEvaluateResult>(bossGreetingExpression(message, job.url));
      } catch (error) {
        if (sendActionMayHaveOccurred) throw unknownReceiptError(error);
        throw error;
      }
      if (result?.ok) {
        if (!result.receiptConfirmed) throw new GreetingReceiptUnknownError();
        return {
          platform: 'boss',
          sentAt: new Date().toISOString(),
          receiptConfirmed: true,
          confirmationMethod: 'outgoing_message_bubble',
          details: result.details,
        };
      }
      if (result?.error) {
        if (sendActionMayHaveOccurred) throw unknownReceiptError(result.error);
        if (result.unavailable) {
          throw new BossJobUnavailableError(result.details ? `${result.error}：${result.details}` : result.error);
        }
        if (result.uncertain) throw new GreetingReceiptUnknownError(result.error);
        throw new Error(result.details ? `${result.error}：${result.details}` : result.error);
      }
      if (result?.action === 'insertText') {
        await session.insertText(message);
      } else if (result?.action === 'clickSend') {
        let actionResult: BossGreetingEvaluateResult;
        try {
          actionResult = await session.evaluateCurrent<BossGreetingEvaluateResult>(bossGreetingClickExpression(message));
        } catch (error) {
          // 发送动作请求已经交给 Chrome；即使 CDP 响应丢失，也不能假定按钮没有被点击。
          throw unknownReceiptError(error);
        }
        if (!actionResult.actionStarted) {
          throw new Error(actionResult.error || 'BOSS 发送按钮未执行点击');
        }
        sendActionMayHaveOccurred = true;
      }
      if (pollIntervalMs > 0) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs));
      }
    }
    const error = result?.error || 'BOSS 自动发送超时';
    if (sendActionMayHaveOccurred) throw unknownReceiptError(error);
    throw new Error(result?.details ? `${error}：${result.details}` : error);
  }
}
