import type { Locator, Page } from 'playwright';
import type { RawJob } from '../types.js';
import { EXPIRED_JOB_SIGNAL_SOURCE, hasExpiredJobSignal, isExpiredJobError } from './availability.js';
import { AuthRequiredError, BaseCrawler, PageStructureError, RateLimitError } from './base.js';
import { CdpChromeSession, PLATFORM_CDP_OPTIONS } from './cdp-chrome.js';
import type { JobSummary } from './boss.js';
import { cityCodeFor } from '../cities.js';

const OPTIONS = PLATFORM_CDP_OPTIONS.zhaopin;
const MIN_ACTION_DELAY_MS = 12_000;
const DETAIL_FETCH_ENV = 'ZHAOPIN_FETCH_DETAILS';
const CARD_SELECTOR = [
  '.zhaopin-job-card',
  '.joblist-box__item',
  '.positionlist__item',
  '.job-card',
  '[data-test="job-card"]',
].join(', ');
const JOB_LINK_SELECTOR = 'a.jobinfo__name, a[href*="/jobdetail/"], a[href*="/jobs/"]';
const TITLE_SELECTOR = '.jobinfo__name, .iteminfo__line1__jobname, .job-title, .job-name, [data-role="job-title"], [data-test="job-title"]';
const COMPANY_SELECTOR = '.companyinfo__name, .iteminfo__line2__compname, .company-name, .company, [data-role="company-name"], [data-test="company-name"]';
const SALARY_SELECTOR = '.jobinfo__salary, .salary, .job-salary, .iteminfo__line2__jobdesc__salary, [data-role="salary"], [data-test="salary"]';
const LOCATION_SELECTOR = '.jobinfo__other-info-item, .job-area, .location, .iteminfo__line2__jobdesc__demand, [data-role="location"], [data-test="location"]';
const OTHER_INFO_SELECTOR = '.jobinfo__other-info-item';
const JOB_TAG_SELECTOR = '.jobinfo__tag .joblist-box__item-tag, .jobinfo__tag span, .jobinfo__tag div, .tag, .job-tag span, .tag-list span, .tag-list li';
const COMPANY_TAG_SELECTOR = '.companyinfo__tag .joblist-box__item-tag, .companyinfo__tag span, .companyinfo__tag div, :scope > .joblist-box__item-tag';
const STAFF_NAME_SELECTOR = '.companyinfo__staff-name';
const STAFF_STATE_SELECTOR = '.companyinfo__staff-state';
export const ZHAOPIN_DETAIL_SELECTORS = [
  '.describtion__detail-content',
  '.describtion',
  '[class*="describtion"]',
  '.job-description',
  '.job-detail',
  '.job-detail__content',
  '.job-detail-content',
  '.pos-ul',
  '.job-sec-text',
];
const DETAIL_SELECTORS = ZHAOPIN_DETAIL_SELECTORS;

export interface ZhaopinJobSummary extends JobSummary {
  experience?: string;
  education?: string;
  recruiter_name?: string;
  recruiter_title?: string;
  company_industry?: string;
  company_stage?: string;
  company_scale?: string;
}

async function firstText(locator: Locator, selector: string): Promise<string> {
  return (await locator.locator(selector).first().textContent({ timeout: 500 }).catch(() => ''))?.trim() ?? '';
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function requirementTags(values: string[]): string[] {
  return values.flatMap((value) => (
    value.match(/应届生|实习生|经验不限|学历不限|本科|大专|硕士|博士|\d+(?:-\d+)?年|不限/g) ?? []
  ));
}

function looksLikeLocation(value: string): boolean {
  return /全国|北京|上海|深圳|广州|杭州|南京|苏州|成都|武汉|西安|重庆|天津|佛山|东莞|珠海|市|区|县|·/.test(value);
}

function looksLikeExperience(value: string): boolean {
  return /经验不限|在校|应届|实习|\d+\s*(?:-\s*\d+)?\s*年/.test(value);
}

function looksLikeEducation(value: string): boolean {
  return /学历不限|高中|中专|大专|本科|硕士|研究生|博士|MBA|统招本科/.test(value);
}

function looksLikeCompanyScale(value: string): boolean {
  return /少于\d+人|\d+\s*-\s*\d+人|\d+人以上|10000人以上/.test(value);
}

function looksLikeCompanyStage(value: string): boolean {
  return /上市公司|已上市|民营|国企|央企|外企|合资|事业单位|不需要融资|未融资|天使轮|[ABCD]轮|新三板|港股|美股/.test(value);
}

function splitRecruiter(value: string): Pick<ZhaopinJobSummary, 'recruiter_name' | 'recruiter_title'> {
  const parts = value.split(/[·|｜丨]/).map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) return { recruiter_name: parts[0], recruiter_title: parts.slice(1).join('·') };
  return { recruiter_name: value.trim() || undefined };
}

function companyProfileFromTags(companyTags: string[]): Pick<ZhaopinJobSummary, 'company_industry' | 'company_stage' | 'company_scale'> {
  const company_scale = companyTags.find(looksLikeCompanyScale);
  const company_stage = companyTags.find((tag) => tag !== company_scale && looksLikeCompanyStage(tag));
  const company_industry = companyTags.find((tag) => (
    tag !== company_scale
    && tag !== company_stage
    && !looksLikeExperience(tag)
    && !looksLikeEducation(tag)
    && !looksLikeLocation(tag)
    && !/回复率|急聘|HR|人事|招聘/.test(tag)
  ));
  return { company_industry, company_stage, company_scale };
}

function inferExperience(tags: string[]): string | undefined {
  return tags.find((tag) => /经验|年|应届|不限/i.test(tag));
}

function inferEducation(tags: string[]): string | undefined {
  return tags.find((tag) => /本科|大专|硕士|博士|学历不限/i.test(tag));
}

export async function extractZhaopinCards(page: Page): Promise<ZhaopinJobSummary[]> {
  let cards = page.locator(CARD_SELECTOR);
  if (await cards.count() === 0) cards = page.locator(JOB_LINK_SELECTOR);
  const summaries: ZhaopinJobSummary[] = [];
  const seen = new Set<string>();
  const count = await cards.count();
  for (let index = 0; index < count; index++) {
    const card = cards.nth(index);
    const [title, company, salary, location, href, jobTags, companyTags, otherInfo, recruiterText, replyState, cardText] = await Promise.all([
      firstText(card, TITLE_SELECTOR),
      firstText(card, COMPANY_SELECTOR),
      firstText(card, SALARY_SELECTOR),
      firstText(card, LOCATION_SELECTOR),
      card.locator(JOB_LINK_SELECTOR).first().getAttribute('href').catch(() => card.getAttribute('href').catch(() => null)),
      card.locator(JOB_TAG_SELECTOR).allTextContents().catch(() => []),
      card.locator(COMPANY_TAG_SELECTOR).allTextContents().catch(() => []),
      card.locator(OTHER_INFO_SELECTOR).allTextContents().catch(() => []),
      firstText(card, STAFF_NAME_SELECTOR),
      firstText(card, STAFF_STATE_SELECTOR),
      card.textContent().catch(() => ''),
    ]);
    const url = href ? new URL(href, OPTIONS.homeUrl).toString() : '';
    if (!title || !company) continue;
    if (hasExpiredJobSignal(cardText ?? '')) continue;
    if (url && seen.has(url)) continue;
    if (url) seen.add(url);
    const profile = companyProfileFromTags(companyTags);
    const recruiter = splitRecruiter(recruiterText);
    summaries.push({
      title,
      company,
      salary,
      location: location || otherInfo.find(looksLikeLocation) || '',
      url,
      tags: unique([...jobTags, ...companyTags, replyState, ...requirementTags(otherInfo)]),
      experience: otherInfo.find(looksLikeExperience) || jobTags.find(looksLikeExperience),
      education: otherInfo.find(looksLikeEducation) || jobTags.find(looksLikeEducation),
      ...recruiter,
      ...profile,
    });
  }
  return summaries;
}

export async function extractZhaopinDetail(page: Page): Promise<string> {
  return (await page.locator(DETAIL_SELECTORS.join(', ')).first().textContent({ timeout: 8_000 }).catch(() => ''))?.trim() ?? '';
}

const LIST_EXPRESSION = `(() => {
  const cardSelector = ${JSON.stringify(CARD_SELECTOR)};
  const jobLinkSelector = ${JSON.stringify(JOB_LINK_SELECTOR)};
  const titleSelector = ${JSON.stringify(TITLE_SELECTOR)};
  const companySelector = ${JSON.stringify(COMPANY_SELECTOR)};
  const salarySelector = ${JSON.stringify(SALARY_SELECTOR)};
  const locationSelector = ${JSON.stringify(LOCATION_SELECTOR)};
  const otherInfoSelector = ${JSON.stringify(OTHER_INFO_SELECTOR)};
  const jobTagSelector = ${JSON.stringify(JOB_TAG_SELECTOR)};
  const companyTagSelector = ${JSON.stringify(COMPANY_TAG_SELECTOR)};
  const staffNameSelector = ${JSON.stringify(STAFF_NAME_SELECTOR)};
  const staffStateSelector = ${JSON.stringify(STAFF_STATE_SELECTOR)};
  const expiredPattern = new RegExp(${JSON.stringify(EXPIRED_JOB_SIGNAL_SOURCE)}, 'i');
  const text = (root, selector) => root.querySelector(selector)?.innerText?.trim() || '';
  const unique = (values) => [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  const requirementTags = (values) => values.flatMap((value) => String(value || '').match(/应届生|实习生|经验不限|学历不限|本科|大专|硕士|博士|\\d+(?:-\\d+)?年|不限/g) || []);
  const looksLikeLocation = (value) => /全国|北京|上海|深圳|广州|杭州|南京|苏州|成都|武汉|西安|重庆|天津|佛山|东莞|珠海|市|区|县|·/.test(String(value || ''));
  const looksLikeExperience = (value) => /经验不限|在校|应届|实习|\\d+\\s*(?:-\\s*\\d+)?\\s*年/.test(String(value || ''));
  const looksLikeEducation = (value) => /学历不限|高中|中专|大专|本科|硕士|研究生|博士|MBA|统招本科/.test(String(value || ''));
  const looksLikeCompanyScale = (value) => /少于\\d+人|\\d+\\s*-\\s*\\d+人|\\d+人以上|10000人以上/.test(String(value || ''));
  const looksLikeCompanyStage = (value) => /上市公司|已上市|民营|国企|央企|外企|合资|事业单位|不需要融资|未融资|天使轮|[ABCD]轮|新三板|港股|美股/.test(String(value || ''));
  const splitRecruiter = (value) => {
    const parts = String(value || '').split(/[·|｜丨]/).map((part) => part.trim()).filter(Boolean);
    if (parts.length >= 2) return { recruiter_name: parts[0], recruiter_title: parts.slice(1).join('·') };
    return { recruiter_name: String(value || '').trim() || undefined };
  };
  const companyProfileFromTags = (companyTags) => {
    const company_scale = companyTags.find(looksLikeCompanyScale);
    const company_stage = companyTags.find((tag) => tag !== company_scale && looksLikeCompanyStage(tag));
    const company_industry = companyTags.find((tag) => (
      tag !== company_scale
      && tag !== company_stage
      && !looksLikeExperience(tag)
      && !looksLikeEducation(tag)
      && !looksLikeLocation(tag)
      && !/回复率|急聘|HR|人事|招聘/.test(tag)
    ));
    return { company_industry, company_stage, company_scale };
  };
  const cardNodes = [...document.querySelectorAll(cardSelector)];
  const nodes = cardNodes.length ? cardNodes : [...document.querySelectorAll(jobLinkSelector)];
  const seen = new Set();
  return nodes.map((card) => {
    const cardText = card.innerText || card.textContent || '';
    const link = card.matches('a[href]') ? card : card.querySelector(jobLinkSelector);
    const otherInfo = [...card.querySelectorAll(otherInfoSelector)].map((node) => node.innerText || node.textContent || '');
    const jobTags = [...card.querySelectorAll(jobTagSelector)].map((node) => node.innerText || node.textContent || '');
    const companyTags = [...card.querySelectorAll(companyTagSelector)].map((node) => node.innerText || node.textContent || '');
    const href = link ? new URL(link.getAttribute('href'), location.href).toString() : '';
    const profile = companyProfileFromTags(companyTags);
    const recruiter = splitRecruiter(text(card, staffNameSelector));
    return {
      title: text(card, titleSelector),
      company: text(card, companySelector),
      salary: text(card, salarySelector),
      location: text(card, locationSelector) || otherInfo.find(looksLikeLocation) || '',
      url: href,
      cardText,
      experience: otherInfo.find(looksLikeExperience) || jobTags.find(looksLikeExperience),
      education: otherInfo.find(looksLikeEducation) || jobTags.find(looksLikeEducation),
      ...recruiter,
      ...profile,
      tags: unique([
        ...jobTags,
        ...companyTags,
        text(card, staffStateSelector),
        ...requirementTags(otherInfo),
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

export class ZhaopinCrawler extends BaseCrawler {
  readonly source = 'zhaopin' as const;
  private readonly session = new CdpChromeSession(this.config, OPTIONS);

  async loginInteractive(timeoutMs = 180_000): Promise<boolean> {
    await this.session.openLogin();
    console.log(`[zhaopin] 请在普通 Chrome 中完成登录，最多等待 ${Math.round(timeoutMs / 1000)} 秒`);
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const url = await this.session.currentUrl().catch(() => undefined);
      if (url && OPTIONS.targetUrlPattern.test(url) && !OPTIONS.authUrlPattern.test(url)) {
        await this.session.saveMarker();
        await this.session.warmHome();
        console.log('[zhaopin] 登录有效；Chrome 用户目录已保存在 data/auth（未导出 Cookie）');
        return true;
      }
      await this.sleep(2_000);
    }
    return false;
  }

  protected async ensureReady(): Promise<void> {
    await this.session.ensureOpen();
  }

  protected async searchPage(keyword: string, pageNumber: number, city: string): Promise<RawJob[]> {
    const pageUrl = this.searchUrl(keyword, pageNumber, city);
    let summaries: ZhaopinJobSummary[];
    try {
      summaries = await this.session.navigateAndEvaluate<ZhaopinJobSummary[]>(pageUrl, LIST_EXPRESSION, 20_000);
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
            console.warn(`[zhaopin] 跳过失效岗位：${summary.title}：${(error as Error).message}`);
            continue;
          }
          console.warn(`[zhaopin] 详情降级为列表摘要：${summary.title}：${(error as Error).message}`);
        }
      }
      jobs.push({
        ...summary,
        source: this.source,
        jd_fulltext: jd,
        experience: summary.experience || inferExperience(summary.tags),
        education: summary.education || inferEducation(summary.tags),
        is_headhunter: /猎头|寻访顾问|招聘顾问|人才顾问|headhunter/i.test(`${summary.recruiter_title ?? ''} ${(summary.tags ?? []).join(' ')}`),
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

  private searchUrl(keyword: string, pageNumber: number, city: string): string {
    const url = new URL('https://sou.zhaopin.com/');
    url.searchParams.set('kw', keyword);
    url.searchParams.set('jl', cityCodeFor(this.source, city));
    url.searchParams.set('p', String(pageNumber));
    return url.toString();
  }

  private summaryText(summary: ZhaopinJobSummary): string {
    return [
      `职位：${summary.title}`,
      `公司：${summary.company}`,
      summary.salary ? `薪资：${summary.salary}` : '',
      summary.location ? `地点：${summary.location}` : '',
      summary.experience ? `经验：${summary.experience}` : '',
      summary.education ? `学历：${summary.education}` : '',
      summary.recruiter_name ? `招聘人：${[summary.recruiter_name, summary.recruiter_title].filter(Boolean).join('·')}` : '',
      summary.company_industry ? `行业：${summary.company_industry}` : '',
      summary.company_stage ? `性质/阶段：${summary.company_stage}` : '',
      summary.company_scale ? `规模：${summary.company_scale}` : '',
      summary.tags?.length ? `标签：${summary.tags.join('、')}` : '',
    ].filter(Boolean).join('\n');
  }

  private shouldFetchDetails(): boolean {
    return process.env[DETAIL_FETCH_ENV]?.toLowerCase() === 'true';
  }

  private rethrowPageError(error: unknown, operation: string): never {
    const message = (error as Error).message || String(error);
    if (/登录|安全验证|passport|login/i.test(message)) throw new AuthRequiredError(this.source, `智联登录态已失效：${message}`);
    if (/频繁|限流|429|captcha|verify/i.test(message)) throw new RateLimitError(this.source, message);
    throw new PageStructureError(this.source, `${operation}异常：${message}`);
  }
}
