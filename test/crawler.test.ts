import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { chromium, type Browser } from 'playwright';
import { extractBossCards, extractBossDetail } from '../src/crawlers/boss.js';
import { extractLiepinCards, extractLiepinDetail } from '../src/crawlers/liepin.js';
import { extractZhaopinCards, extractZhaopinDetail } from '../src/crawlers/zhaopin.js';

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser.close(); });

describe('BOSS 页面解析 fixture', () => {
  it('在跳转详情前快照列表卡片', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <ul class="job-list-box">
        <li class="job-card-wrapper">
          <a class="job-card-left" href="/job_detail/abc123.html">
            <span class="job-name">AI Agent工程师</span>
            <span class="salary">20-35K</span>
          </a>
          <span class="company-name">湾区智能</span>
          <span class="job-area">深圳·南山</span>
          <ul class="tag-list"><li>1-3年</li><li>本科</li></ul>
        </li>
        <li class="job-card-wrapper">
          <a class="job-card-left" href="/job_detail/def456.html"><span class="job-name">AI解决方案顾问</span></a>
          <span class="company-name">方案科技</span><span class="salary">18-30K</span><span class="job-area">深圳</span>
        </li>
      </ul>
    `);
    const cards = await extractBossCards(page);
    assert.equal(cards.length, 2);
    assert.equal(cards[0].title, 'AI Agent工程师');
    assert.equal(cards[0].url, 'https://www.zhipin.com/job_detail/abc123.html');
    assert.deepEqual(cards[0].tags, ['1-3年', '本科']);
    await page.close();
  });

  it('从详情 fixture 提取完整 JD', async () => {
    const page = await browser.newPage();
    await page.setContent('<section class="job-sec-text">负责 RAG 与 Agent 应用落地。</section>');
    assert.equal(await extractBossDetail(page), '负责 RAG 与 Agent 应用落地。');
    await page.close();
  });
});

describe('猎聘页面解析 fixture', () => {
  it('解析猎聘列表卡片', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="liepin-job-card">
        <a href="/job/1966450015.shtml"><span class="job-title">AI解决方案顾问</span></a>
        <span class="salary">20-35k</span>
        <span class="location">深圳</span>
        <span class="company-name">南山智能科技</span>
        <div class="job-tags"><span>3-5年</span><span>本科</span><span>大模型</span></div>
      </div>
    `);
    const cards = await extractLiepinCards(page);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].title, 'AI解决方案顾问');
    assert.equal(cards[0].company, '南山智能科技');
    assert.equal(cards[0].url, 'https://www.liepin.com/job/1966450015.shtml');
    assert.deepEqual(cards[0].tags, ['3-5年', '本科', '大模型']);
    await page.close();
  });

  it('解析猎聘真实搜索页的 data-nick 卡片结构', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="job-card-pc-container">
        <div class="job-detail-box">
          <a data-nick="job-detail-job-info" href="https://www.liepin.com/job/1982646795.shtml">
            <div>
              <div class="ellipsis-1" title="招聘AI产品（客服业务）">AI产品（客服业务）</div>
              <div><span>【</span><span class="ellipsis-1">深圳-南山区</span><span>】</span></div>
            </div>
            <span class="job-salary">15-30k·15薪</span>
            <div><span>3-5年</span><span>统招本科</span></div>
          </a>
          <div data-nick="job-detail-company-info">
            <span class="ellipsis-1">拓竹科技</span>
            <div><span>机械/设备</span><span>C轮</span><span>1000-2000人</span></div>
          </div>
        </div>
      </div>
    `);
    const cards = await extractLiepinCards(page);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].title, 'AI产品（客服业务）');
    assert.equal(cards[0].company, '拓竹科技');
    assert.equal(cards[0].salary, '15-30k·15薪');
    assert.equal(cards[0].location, '深圳-南山区');
    assert.deepEqual(cards[0].tags, ['3-5年', '统招本科', '机械/设备C轮1000-2000人']);
    await page.close();
  });

  it('过滤猎聘列表里的失效岗位', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="liepin-job-card">
        <a href="/job/active.shtml"><span class="job-title">AI解决方案顾问</span></a>
        <span class="salary">20-35k</span>
        <span class="company-name">有效科技</span>
      </div>
      <div class="liepin-job-card">
        <a href="/job/expired.shtml"><span class="job-title">AI产品经理</span></a>
        <span class="company-name">过期科技</span>
        <span>职位已下线</span>
      </div>
    `);
    const cards = await extractLiepinCards(page);
    assert.deepEqual(cards.map((card) => card.company), ['有效科技']);
    await page.close();
  });

  it('解析猎聘详情 JD', async () => {
    const page = await browser.newPage();
    await page.setContent('<section class="job-description">负责企业 AI 解决方案咨询和客户成功。</section>');
    assert.equal(await extractLiepinDetail(page), '负责企业 AI 解决方案咨询和客户成功。');
    await page.close();
  });

  it('解析猎聘详情页的动态 intro 容器', async () => {
    const page = await browser.newPage();
    await page.setContent('<section class="pc-job-intro-content">职位描述\\n负责 AI 产品方案、售前沟通与交付复盘。</section>');
    assert.equal(await extractLiepinDetail(page), '职位描述\\n负责 AI 产品方案、售前沟通与交付复盘。');
    await page.close();
  });
});

describe('智联页面解析 fixture', () => {
  it('解析智联列表卡片', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="zhaopin-job-card">
        <a href="/jobs/CC123/567.htm"><span class="job-title">AI产品经理</span></a>
        <span class="job-salary">18-28K</span>
        <span class="location">深圳·福田</span>
        <span class="company-name">湾区云产品</span>
        <div class="tag-list"><span>1-3年</span><span>本科</span><span>售前支持</span></div>
      </div>
    `);
    const cards = await extractZhaopinCards(page);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].title, 'AI产品经理');
    assert.equal(cards[0].company, '湾区云产品');
    assert.equal(cards[0].url, 'https://www.zhaopin.com/jobs/CC123/567.htm');
    assert.deepEqual(cards[0].tags, ['1-3年', '本科', '售前支持']);
    await page.close();
  });

  it('解析智联真实搜索页的 jobinfo 卡片结构', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="joblist-box__item clearfix">
        <div class="jobinfo">
          <div class="jobinfo__top">
            <a class="jobinfo__name" href="http://www.zhaopin.com/jobdetail/CC139506240J40683450002.htm">客户成功经理</a>
            <p class="jobinfo__salary">1-2万·15薪</p>
          </div>
          <div class="jobinfo__tag">
            <div class="joblist-box__item-tag">KA大客户</div>
            <div class="joblist-box__item-tag">金融行业客户</div>
          </div>
          <div class="jobinfo__other-info">
            <div class="jobinfo__other-info-item">深圳·福田·莲花</div>
            <div class="jobinfo__other-info-item">1-3年</div>
            <div class="jobinfo__other-info-item">本科</div>
          </div>
        </div>
        <div class="companyinfo">
          <a class="companyinfo__name" href="https://www.zhaopin.com/companydetail/CZ139506240.htm">广州市新文溯科技有限公司</a>
          <div class="companyinfo__tag">
            <div class="joblist-box__item-tag">民营</div>
            <div class="joblist-box__item-tag">20-99人</div>
            <div class="joblist-box__item-tag">软件/IT服务</div>
          </div>
          <div class="companyinfo__staff-name">王女士·客户成功招聘</div>
          <div class="companyinfo__staff-state">高回复率</div>
        </div>
      </div>
    `);
    const cards = await extractZhaopinCards(page);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].title, '客户成功经理');
    assert.equal(cards[0].company, '广州市新文溯科技有限公司');
    assert.equal(cards[0].salary, '1-2万·15薪');
    assert.equal(cards[0].location, '深圳·福田·莲花');
    assert.equal(cards[0].experience, '1-3年');
    assert.equal(cards[0].education, '本科');
    assert.equal(cards[0].company_stage, '民营');
    assert.equal(cards[0].company_scale, '20-99人');
    assert.equal(cards[0].company_industry, '软件/IT服务');
    assert.equal(cards[0].recruiter_name, '王女士');
    assert.equal(cards[0].recruiter_title, '客户成功招聘');
    assert.deepEqual(cards[0].tags, ['KA大客户', '金融行业客户', '民营', '20-99人', '软件/IT服务', '高回复率', '1-3年', '本科']);
    assert.equal(cards[0].url, 'http://www.zhaopin.com/jobdetail/CC139506240J40683450002.htm');
    await page.close();
  });

  it('过滤智联列表里的停止招聘岗位', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="zhaopin-job-card">
        <a href="/jobs/active.htm"><span class="job-title">AI客户成功经理</span></a>
        <span class="company-name">有效云</span>
        <span class="job-salary">18-28K</span>
      </div>
      <div class="zhaopin-job-card">
        <a href="/jobs/expired.htm"><span class="job-title">AI产品经理</span></a>
        <span class="company-name">过期云</span>
        <span>停止招聘</span>
      </div>
    `);
    const cards = await extractZhaopinCards(page);
    assert.deepEqual(cards.map((card) => card.company), ['有效云']);
    await page.close();
  });

  it('解析智联详情 JD', async () => {
    const page = await browser.newPage();
    await page.setContent('<section class="describtion__detail-content">负责 AI 产品规划、客户访谈与交付复盘。</section>');
    assert.equal(await extractZhaopinDetail(page), '负责 AI 产品规划、客户访谈与交付复盘。');
    await page.close();
  });

  it('解析智联真实详情页的动态 describtion 容器', async () => {
    const page = await browser.newPage();
    await page.setContent('<section class="foo-describtion-content">职位描述\\n负责 AI 平台运营、客户沟通和产品迭代。</section>');
    assert.equal(await extractZhaopinDetail(page), '职位描述\\n负责 AI 平台运营、客户沟通和产品迭代。');
    await page.close();
  });
});
