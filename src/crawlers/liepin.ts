import type { Locator, Page } from 'playwright';
import type { RawJob } from '../types.js';
import { EXPIRED_JOB_SIGNAL_SOURCE, hasExpiredJobSignal, isExpiredJobError } from './availability.js';
import { AuthRequiredError, BaseCrawler, PageStructureError, RateLimitError } from './base.js';
import { CdpChromeSession, PLATFORM_CDP_OPTIONS } from './cdp-chrome.js';
import type { JobSummary } from './boss.js';

const OPTIONS = PLATFORM_CDP_OPTIONS.liepin;
const MIN_ACTION_DELAY_MS = 12_000;
const DETAIL_FETCH_ENV = 'LIEPIN_FETCH_DETAILS';
const CARD_SELECTOR = [
  '.liepin-job-card',
  '.job-card-pc-container',
  '.job-card',
  '.job-list-item',
  '[data-test="job-card"]',
].join(', ');
const JOB_LINK_SELECTOR = 'a[data-nick="job-detail-job-info"], a[href*="/job/"], a[href*="/a/"]';
const COMPANY_BOX_SELECTOR = '[data-nick="job-detail-company-info"], .job-detail-company-box, .company-name, .company, [data-role="company-name"], [data-test="company-name"]';
const TITLE_SELECTOR = '.job-title, .job-name, [data-role="job-title"], [data-test="job-title"], a[data-nick="job-detail-job-info"] [title], a[data-nick="job-detail-job-info"] .ellipsis-1';
const COMPANY_SELECTOR = '.company-name, .company, [data-role="company-name"], [data-test="company-name"], [data-nick="job-detail-company-info"] .ellipsis-1';
const SALARY_SELECTOR = '.salary, .job-salary, [data-role="salary"], [data-test="salary"]';
const LOCATION_SELECTOR = '.job-area, .location, .area, .job-dq-box, [data-role="location"], [data-test="location"]';
const TAG_SELECTOR = '.tag, .labels span, .job-tags span, .tag-list span, .tag-list li';
export const LIEPIN_DETAIL_SELECTORS = [
  '.job-intro-container',
  '[class*="job-intro"]',
  '.job-description',
  '[class*="job-description"]',
  '.job-detail',
  '.content-word',
  '[class*="content-word"]',
  '[data-selector="job-intro"]',
];
const DETAIL_SELECTORS = LIEPIN_DETAIL_SELECTORS;

async function firstText(locator: Locator, selector: string): Promise<string> {
  return (await locator.locator(selector).first().textContent({ timeout: 500 }).catch(() => ''))?.trim() ?? '';
}

function linesOf(text: string): string[] {
  return text.split(/\n+/).map((line) => line.trim()).filter((line) => line && line !== '【' && line !== '】');
}

function cleanTitle(value: string): string {
  return value.replace(/^招聘/, '').trim();
}

function cleanLocation(value: string): string {
  return value.replace(/[【】]/g, '').replace(/\s+/g, '').trim();
}

function salaryFromLines(lines: string[]): string {
  return lines.map((line) => line.match(/面议|(?:\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?)\s*[kK](?:·\d+薪)?|(?:\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?)万(?:\/年|\/月)?/i)?.[0] ?? '')
    .find(Boolean) ?? '';
}

function locationFromText(text: string): string {
  const candidates = [...text.matchAll(/【\s*([\s\S]*?)\s*】/g)].map((match) => cleanLocation(match[1]));
  return candidates.find((value) => /全国|北京|上海|深圳|广州|杭州|南京|苏州|成都|武汉|西安|重庆|天津|佛山|东莞|珠海|市|区|县|-/.test(value)) ?? candidates[0] ?? '';
}

function requirementTags(lines: string[]): string[] {
  return lines.flatMap((line) => (
    line.match(/应届生|实习生|经验不限|学历不限|统招本科|本科|大专|硕士|博士|\d+(?:-\d+)?年|不限/g) ?? []
  ));
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function inferExperience(tags: string[]): string | undefined {
  return tags.find((tag) => /经验|年|应届|不限/i.test(tag));
}

function inferEducation(tags: string[]): string | undefined {
  return tags.find((tag) => /本科|大专|硕士|博士|学历不限/i.test(tag));
}

export async function extractLiepinCards(page: Page): Promise<JobSummary[]> {
  let cards = page.locator(CARD_SELECTOR);
  if (await cards.count() === 0) cards = page.locator(JOB_LINK_SELECTOR);
  const summaries: JobSummary[] = [];
  const seen = new Set<string>();
  const count = await cards.count();
  for (let index = 0; index < count; index++) {
    const card = cards.nth(index);
    const [explicitTitle, explicitCompany, explicitSalary, explicitLocation, href, tags, linkText, companyText, cardText] = await Promise.all([
      firstText(card, TITLE_SELECTOR),
      firstText(card, COMPANY_SELECTOR),
      firstText(card, SALARY_SELECTOR),
      firstText(card, LOCATION_SELECTOR),
      card.locator(JOB_LINK_SELECTOR).first().getAttribute('href').catch(() => card.getAttribute('href').catch(() => null)),
      card.locator(TAG_SELECTOR).allTextContents().catch(() => []),
      card.locator(JOB_LINK_SELECTOR).first().textContent().catch(() => ''),
      card.locator(COMPANY_BOX_SELECTOR).first().textContent().catch(() => ''),
      card.textContent().catch(() => ''),
    ]);
    const linkLines = linesOf(linkText ?? '');
    const companyLines = linesOf(companyText ?? explicitCompany);
    const title = cleanTitle(explicitTitle) || cleanTitle(linkLines[0] ?? '');
    const company = companyLines[0] ?? explicitCompany;
    const salary = explicitSalary || salaryFromLines(linkLines);
    const location = cleanLocation(explicitLocation) || locationFromText(linkText ?? '');
    const url = href ? new URL(href, OPTIONS.homeUrl).toString() : '';
    if (!title || !company) continue;
    if (hasExpiredJobSignal(cardText ?? '')) continue;
    if (url && seen.has(url)) continue;
    if (url) seen.add(url);
    summaries.push({
      title,
      company: company.trim(),
      salary: salary.trim(),
      location,
      url,
      tags: unique([
        ...tags,
        ...requirementTags(linkLines),
        ...companyLines.slice(1),
      ]),
    });
  }
  return summaries;
}

export async function extractLiepinDetail(page: Page): Promise<string> {
  return (await page.locator(DETAIL_SELECTORS.join(', ')).first().textContent({ timeout: 8_000 }).catch(() => ''))?.trim() ?? '';
}

const LIST_EXPRESSION = `(() => {
  const cardSelector = ${JSON.stringify(CARD_SELECTOR)};
  const jobLinkSelector = ${JSON.stringify(JOB_LINK_SELECTOR)};
  const companyBoxSelector = ${JSON.stringify(COMPANY_BOX_SELECTOR)};
  const titleSelector = ${JSON.stringify(TITLE_SELECTOR)};
  const companySelector = ${JSON.stringify(COMPANY_SELECTOR)};
  const salarySelector = ${JSON.stringify(SALARY_SELECTOR)};
  const locationSelector = ${JSON.stringify(LOCATION_SELECTOR)};
  const tagSelector = ${JSON.stringify(TAG_SELECTOR)};
  const expiredPattern = new RegExp(${JSON.stringify(EXPIRED_JOB_SIGNAL_SOURCE)}, 'i');
  const text = (root, selector) => root.querySelector(selector)?.innerText?.trim() || '';
  const linesOf = (value) => String(value || '').split(/\\n+/).map((line) => line.trim()).filter((line) => line && line !== '【' && line !== '】');
  const cleanTitle = (value) => String(value || '').replace(/^招聘/, '').trim();
  const cleanLocation = (value) => String(value || '').replace(/[【】]/g, '').replace(/\\s+/g, '').trim();
  const salaryFromLines = (lines) => lines.map((line) => line.match(/面议|(?:\\d+(?:\\.\\d+)?\\s*-\\s*\\d+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)\\s*[kK](?:·\\d+薪)?|(?:\\d+(?:\\.\\d+)?\\s*-\\s*\\d+(?:\\.\\d+)?)万(?:\\/年|\\/月)?/i)?.[0] || '').find(Boolean) || '';
  const locationFromText = (value) => {
    const candidates = [...String(value || '').matchAll(/【\\s*([\\s\\S]*?)\\s*】/g)].map((match) => cleanLocation(match[1]));
    return candidates.find((item) => /全国|北京|上海|深圳|广州|杭州|南京|苏州|成都|武汉|西安|重庆|天津|佛山|东莞|珠海|市|区|县|-/.test(item)) || candidates[0] || '';
  };
  const requirementTags = (lines) => lines.flatMap((line) => line.match(/应届生|实习生|经验不限|学历不限|统招本科|本科|大专|硕士|博士|\\d+(?:-\\d+)?年|不限/g) || []);
  const unique = (values) => [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  const cardNodes = [...document.querySelectorAll(cardSelector)];
  const nodes = cardNodes.length ? cardNodes : [...document.querySelectorAll(jobLinkSelector)];
  const seen = new Set();
  return nodes.map((card) => {
    const cardText = card.innerText || card.textContent || '';
    const link = card.matches('a[href]') ? card : card.querySelector(jobLinkSelector);
    const linkText = link?.innerText || link?.textContent || '';
    const linkLines = linesOf(linkText);
    const companyBox = card.querySelector(companyBoxSelector);
    const companyLines = linesOf(companyBox?.innerText || companyBox?.textContent || text(card, companySelector));
    const href = link ? new URL(link.getAttribute('href'), location.href).toString() : '';
    const title = cleanTitle(text(card, titleSelector)) || cleanTitle(linkLines[0] || '');
    const company = companyLines[0] || text(card, companySelector);
    const salary = text(card, salarySelector) || salaryFromLines(linkLines);
    const jobLocation = cleanLocation(text(card, locationSelector)) || locationFromText(linkText);
    return {
      title,
      company,
      salary,
      location: jobLocation,
      url: href,
      cardText,
      tags: unique([
        ...[...card.querySelectorAll(tagSelector)].map((node) => node.innerText || node.textContent || ''),
        ...requirementTags(linkLines),
        ...companyLines.slice(1),
      ]),
    };
  }).filter((job) => {
    if (!job.title || !job.company) return false;
    if (expiredPattern.test(String(job.cardText || '').replace(/\\s+/g, ' '))) return false;
    if (job.url && seen.has(job.url)) return false;
    if (job.url) seen.add(job.url);
    return true;
  });
})()`;

export class LiepinCrawler extends BaseCrawler {
  readonly source = 'liepin' as const;
  private readonly session = new CdpChromeSession(this.config, OPTIONS);

  async loginInteractive(timeoutMs = 180_000): Promise<boolean> {
    await this.session.openLogin();
    console.log(`[liepin] 请在普通 Chrome 中完成登录，最多等待 ${Math.round(timeoutMs / 1000)} 秒`);
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const url = await this.session.currentUrl().catch(() => undefined);
      if (url && OPTIONS.targetUrlPattern.test(url) && !OPTIONS.authUrlPattern.test(url)) {
        await this.session.saveMarker();
        await this.session.warmHome();
        console.log('[liepin] 登录有效；Chrome 用户目录已保存在 data/auth（未导出 Cookie）');
        return true;
      }
      await this.sleep(2_000);
    }
    return false;
  }

  protected async ensureReady(): Promise<void> {
    await this.session.ensureOpen();
  }

  protected async searchPage(keyword: string, pageNumber: number): Promise<RawJob[]> {
    const pageUrl = this.searchUrl(keyword, pageNumber);
    let summaries: JobSummary[];
    try {
      summaries = await this.session.navigateAndEvaluate<JobSummary[]>(pageUrl, LIST_EXPRESSION, 20_000);
    } catch (error) {
      this.rethrowPageError(error, `搜索「${keyword}」第 ${pageNumber} 页`);
    }
    const jobs: RawJob[] = [];
    const fetchDetails = this.shouldFetchDetails();
    for (const summary of summaries) {
      let jd = this.summaryText(summary);
      if (fetchDetails && summary.url) {
        try {
          jd = await this.session.navigateAndExtractText(summary.url, DETAIL_SELECTORS, 20_000) || jd;
          await this.randomDelay();
        } catch (error) {
          if (isExpiredJobError(error)) {
            console.warn(`[liepin] 跳过失效岗位：${summary.title}：${(error as Error).message}`);
            continue;
          }
          console.warn(`[liepin] 详情降级为列表摘要：${summary.title}：${(error as Error).message}`);
        }
      }
      jobs.push({
        ...summary,
        source: this.source,
        jd_fulltext: jd,
        experience: inferExperience(summary.tags),
        education: inferEducation(summary.tags),
      });
    }
    return jobs;
  }

  protected override async randomDelay(): Promise<void> {
    const delayMinMs = Math.max(this.config.delayMinMs, MIN_ACTION_DELAY_MS);
    const delayMaxMs = Math.max(this.config.delayMaxMs, delayMinMs + 8_000);
    const delay = delayMinMs + Math.random() * (delayMaxMs - delayMinMs);
    await this.sleep(delay);
  }

  private searchUrl(keyword: string, pageNumber: number): string {
    const url = new URL('/zhaopin/', OPTIONS.homeUrl);
    url.searchParams.set('key', keyword);
    url.searchParams.set('dqs', '050090');
    url.searchParams.set('currentPage', String(Math.max(0, pageNumber - 1)));
    return url.toString();
  }

  private summaryText(summary: JobSummary): string {
    return [
      summary.title,
      summary.company,
      summary.salary,
      summary.location,
      ...(summary.tags ?? []),
    ].filter(Boolean).join('\n');
  }

  private shouldFetchDetails(): boolean {
    return process.env[DETAIL_FETCH_ENV]?.toLowerCase() === 'true';
  }

  private rethrowPageError(error: unknown, operation: string): never {
    const message = (error as Error).message || String(error);
    if (/登录|安全验证|passport|login/i.test(message)) throw new AuthRequiredError(this.source, `猎聘登录态已失效：${message}`);
    if (/频繁|限流|429|captcha|verify/i.test(message)) throw new RateLimitError(this.source, message);
    throw new PageStructureError(this.source, `${operation}异常：${message}`);
  }
}
