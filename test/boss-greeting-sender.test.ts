import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import {
  BossGreetingSender,
  GreetingReceiptUnknownError,
  bossGreetingClickExpression,
  bossGreetingExpression,
  type BossGreetingBrowserSession,
} from '../src/services/boss-greeting-sender.js';
import type { ScoredJob } from '../src/types.js';

const senderTestJob = {
  source: 'boss',
  url: 'https://www.zhipin.com/job_detail/test.html',
} as ScoredJob;

function scriptedSession(
  evaluate: (expression: string, call: number) => unknown | Promise<unknown>
): BossGreetingBrowserSession {
  let evaluateCalls = 0;
  return {
    navigate: async () => undefined,
    insertText: async () => undefined,
    evaluateCurrent: async <T>(expression: string) => evaluate(expression, evaluateCalls++) as Promise<T>,
  };
}

describe('BOSS 打招呼页面驱动脚本', () => {
  let browser: Browser;
  let page: Page;

  before(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });

  after(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    await page.evaluate(() => { delete (window as any).__jobHunterGreeting; });
  });

  it('岗位正文包含 safety 时不会误判为安全验证页', async () => {
    await page.setContent(`
      <main>
        <p>Ensuring the high efficiency, safety, precision, and reliability of every device.</p>
        <div contenteditable="true" id="chat-input" class="chat-input"></div>
        <button type="send" class="btn-v2 btn-sure-v2 btn-send">发送</button>
      </main>
    `);

    const result = await page.evaluate<any>(bossGreetingExpression('您好，想进一步沟通。'));
    assert.equal(result.action, 'insertText');
    assert.equal(result.error, undefined);
  });

  it('页面出现明确安全验证提示时仍在发送前阻断', async () => {
    await page.setContent(`
      <main>
        <h1>请完成安全验证</h1>
        <p>验证通过后继续访问 BOSS 直聘。</p>
      </main>
    `);

    const result = await page.evaluate<any>(bossGreetingExpression('您好，想进一步沟通。'));
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /登录、安全验证或验证码/);
  });

  it('contenteditable 文本写入后补发输入事件，等待页面解锁发送按钮', async () => {
    await page.setContent(`
      <main>
        <div contenteditable="true" id="chat-input" class="chat-input"></div>
        <button type="send" class="btn-v2 btn-sure-v2 btn-send disabled">发送</button>
      </main>
      <script>
        const input = document.querySelector('#chat-input');
        input.addEventListener('input', () => {
          if (input.textContent) {
            document.querySelector('.btn-send').classList.remove('disabled');
            window.__inputSynchronized = true;
          }
        });
      </script>
    `);

    const message = '您好，我对岗位要求中的职责感兴趣，想进一步沟通。';
    let result = await page.evaluate<any>(bossGreetingExpression(message));
    assert.equal(result.action, 'insertText');
    // 模拟页面文本已变化、但框架状态尚未收到 input 事件的真实失败场景。
    await page.evaluate((text) => { document.querySelector('#chat-input')!.textContent = text; }, message);
    result = await page.evaluate<any>(bossGreetingExpression(message));
    assert.equal(result, false);
    result = await page.evaluate<any>(bossGreetingExpression(message));
    assert.equal(result.action, 'clickSend');
    assert.equal(await page.evaluate(() => (window as any).__inputSynchronized), true);
  });

  it('发送按钮持续禁用时确定性失败且不触发 Enter', async () => {
    await page.setContent(`
      <main>
        <div contenteditable="true" id="chat-input" class="chat-input"></div>
        <button type="send" class="btn-v2 btn-sure-v2 btn-send disabled">发送</button>
      </main>
      <script>
        document.querySelector('#chat-input').addEventListener('keydown', () => {
          window.__enterPressed = true;
        });
      </script>
    `);
    const message = '您好，我有企业解决方案经验，希望进一步沟通岗位。';
    let result = await page.evaluate<any>(bossGreetingExpression(message));
    assert.equal(result.action, 'insertText');
    await page.keyboard.insertText(message);
    result = await page.evaluate<any>(bossGreetingExpression(message));
    assert.equal(result, false);
    await page.evaluate(() => {
      (window as any).__jobHunterGreeting.sendReadyWaitStartedAt = Date.now() - 4000;
    });
    result = await page.evaluate<any>(bossGreetingExpression(message));
    assert.match(result.error ?? '', /发送按钮未启用/);
    assert.equal(result.uncertain, undefined);
    assert.equal(await page.evaluate(() => (window as any).__enterPressed), undefined);
  });

  it('输入框清空但没有新增本人消息气泡时不能当作发送成功', async () => {
    await page.setContent(`
      <main>
        <div contenteditable="true" id="chat-input" class="chat-input"></div>
        <button type="send" class="btn-v2 btn-sure-v2 btn-send">发送</button>
      </main>
    `);
    const message = '您好，我有企业解决方案经验，希望进一步沟通岗位。';
    let result = await page.evaluate<any>(bossGreetingExpression(message));
    assert.equal(result.action, 'insertText');
    await page.keyboard.insertText(message);
    result = await page.evaluate<any>(bossGreetingExpression(message));
    assert.equal(result, false);
    result = await page.evaluate<any>(bossGreetingExpression(message));
    assert.equal(result.action, 'clickSend');
    result = await page.evaluate<any>(bossGreetingClickExpression(message));
    assert.equal(result.actionStarted, true);
    await page.evaluate(() => { (window as any).__jobHunterGreeting.sendRequestedAt = Date.now() - 13000; });
    result = await page.evaluate<any>(bossGreetingExpression(message));
    assert.equal(result.ok, false);
    assert.equal(result.uncertain, true);
  });

  it('历史相同消息不能冒充本次新增回执', async () => {
    const message = '您好，我有客户交付经验，希望进一步沟通具体职责。';
    await page.setContent(`
      <main>
        <div class="message-item item-myself">${message}</div>
        <div contenteditable="true" id="chat-input" class="chat-input"></div>
        <button type="send" class="btn-v2 btn-sure-v2 btn-send">发送</button>
      </main>
    `);
    let result = await page.evaluate<any>(bossGreetingExpression(message));
    assert.equal(result.action, 'insertText');
    await page.keyboard.insertText(message);
    result = await page.evaluate<any>(bossGreetingExpression(message));
    assert.equal(result, false);
    result = await page.evaluate<any>(bossGreetingExpression(message));
    assert.equal(result.action, 'clickSend');
    result = await page.evaluate<any>(bossGreetingClickExpression(message));
    assert.equal(result.actionStarted, true);
    result = await page.evaluate<any>(bossGreetingExpression(message));
    assert.equal(result, false);
  });

  it('识别 BOSS 页面不存在为岗位不可用', async () => {
    await page.setContent(`
      <title>您访问的页面不存在-BOSS直聘</title>
      <main>您访问的页面不存在</main>
    `);

    const result = await page.evaluate<any>(
      bossGreetingExpression('您好，想进一步沟通。')
    );
    assert.equal(result.unavailable, true);
    assert.match(result.error ?? '', /岗位已失效/);
  });

  it('同一模板切换岗位后重新核对目标，错误岗位不写入也不点击', async () => {
    await page.route('https://www.zhipin.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<div id="chat-input" contenteditable="true"></div><button class="btn-send">发送</button>' }));
    await page.goto('https://www.zhipin.com/job_detail/a.html');
    const message = '您好，希望进一步了解这个岗位。';
    const a = await page.evaluate<any>(bossGreetingExpression(message, 'https://www.zhipin.com/job_detail/a.html'));
    assert.equal(a.action, 'insertText');
    const wrong = await page.evaluate<any>(bossGreetingExpression(message, 'https://www.zhipin.com/job_detail/b.html'));
    assert.equal(wrong, false);
    assert.equal(await page.locator('#chat-input').innerText(), '');
    await page.evaluate(() => { (window as any).__jobHunterGreeting.startedAt -= 13000; });
    const timeout = await page.evaluate<any>(bossGreetingExpression(message, 'https://www.zhipin.com/job_detail/b.html'));
    assert.match(timeout.error, /核对目标岗位/);
  });
});

describe('BossGreetingSender 发送动作边界', () => {
  it('发送按钮动作请求的 CDP 响应丢失时标记回执未知', async () => {
    const session = scriptedSession((_expression, call) => {
      if (call === 0) return { action: 'insertText' };
      if (call === 1) return { action: 'clickSend' };
      // 动作表达式可能已在 Chrome 内执行 send.click()，仅 CDP 响应连接丢失。
      throw new Error('CDP Runtime.evaluate 连接失败');
    });
    const sender = new BossGreetingSender({
      enabled: true,
      sessionFactory: () => session,
      pollIntervalMs: 0,
    });

    await assert.rejects(
      sender.send(senderTestJob, '您好，希望进一步沟通岗位。'),
      (error: unknown) => error instanceof GreetingReceiptUnknownError
        && /Runtime\.evaluate 连接失败/.test(error.message)
    );
  });

  it('发送动作前的确定性页面异常仍是可安全重试的普通失败', async () => {
    const session = scriptedSession(() => ({ error: '未找到 BOSS 沟通入口' }));
    const sender = new BossGreetingSender({
      enabled: true,
      sessionFactory: () => session,
      pollIntervalMs: 0,
    });

    await assert.rejects(
      sender.send(senderTestJob, '您好，希望进一步沟通岗位。'),
      (error: unknown) => error instanceof Error
        && !(error instanceof GreetingReceiptUnknownError)
        && /未找到 BOSS 沟通入口/.test(error.message)
    );
  });

  it('发送按钮未启用属于发送前失败，不标记为回执未知', async () => {
    const session = scriptedSession((_expression, call) => {
      if (call === 0) return { action: 'insertText' };
      return { error: 'BOSS 消息已写入，但发送按钮未启用；未执行发送动作' };
    });
    const sender = new BossGreetingSender({
      enabled: true,
      sessionFactory: () => session,
      pollIntervalMs: 0,
    });

    await assert.rejects(
      sender.send(senderTestJob, '您好，希望进一步沟通岗位。'),
      (error: unknown) => error instanceof Error
        && !(error instanceof GreetingReceiptUnknownError)
        && /未执行发送动作/.test(error.message)
    );
  });
});
