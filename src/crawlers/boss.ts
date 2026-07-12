import type { Page } from 'playwright';
import type { RawJob } from '../types.js';
import { AuthRequiredError, BaseCrawler, PageStructureError, RateLimitError } from './base.js';
import { CdpChromeSession, type BrowserFetchResult } from './cdp-chrome.js';
import { cityCodeFor } from '../cities.js';

export interface JobSummary {
  title: string;
  company: string;
  salary: string;
  location: string;
  url: string;
  tags: string[];
  recruiter_name?: string;
  recruiter_title?: string;
  is_headhunter?: boolean;
}

export async function extractBossCards(page: Page): Promise<JobSummary[]> {
  const cards = page.locator('.job-card-wrapper, .search-job-result .job-list-box > li');
  const summaries: JobSummary[] = [];
  const count = await cards.count();
  for (let index = 0; index < count; index++) {
    const card = cards.nth(index);
    const [title, company, salary, location, href, tags] = await Promise.all([
      card.locator('.job-name').first().textContent().catch(() => null),
      card.locator('.company-name').first().textContent().catch(() => null),
      card.locator('.salary').first().textContent().catch(() => null),
      card.locator('.job-area').first().textContent().catch(() => null),
      card.locator('a.job-card-left, a[href*="/job_detail/"]').first().getAttribute('href').catch(() => null),
      card.locator('.tag-list li, .job-card-footer .tag-list span').allTextContents().catch(() => []),
    ]);
    if (!title?.trim() || !company?.trim()) continue;
    summaries.push({
      title: title.trim(), company: company.trim(), salary: salary?.trim() ?? '',
      location: location?.trim() ?? '',
      url: href ? new URL(href, 'https://www.zhipin.com').toString() : '',
      tags: tags.map((tag) => tag.trim()).filter(Boolean),
    });
  }
  return summaries;
}

export async function extractBossDetail(page: Page): Promise<string> {
  return (await page.locator('.job-sec-text, .job-detail-section .text, .job-detail').first().textContent({ timeout: 8_000 }).catch(() => ''))?.trim() ?? '';
}

interface BossApiEnvelope<T> {
  code?: number;
  message?: string;
  zpData?: T;
}

interface BossListItem {
  encryptJobId?: string;
  securityId?: string;
  jobName?: string;
  brandName?: string;
  salaryDesc?: string;
  cityName?: string;
  areaDistrict?: string;
  jobExperience?: string;
  jobDegree?: string;
  skills?: unknown[];
  welfareList?: unknown[];
  postDescription?: string;
  bossName?: string;
  bossTitle?: string;
  brandIndustry?: string;
  brandIndustryName?: string;
  brandStageName?: string;
  brandStage?: string;
  brandScaleName?: string;
  brandScale?: string;
}

function stringList(values: unknown[] | undefined): string[] {
  return (values ?? []).map((value) => {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      const item = value as Record<string, unknown>;
      return String(item.name ?? item.label ?? item.value ?? '');
    }
    return '';
  }).map((value) => value.trim()).filter(Boolean);
}

function locationOf(city?: string, district?: string): string {
  return [city, district].filter(Boolean).join('·');
}

export class BossCrawler extends BaseCrawler {
  readonly source = 'boss' as const;
  private readonly session = new CdpChromeSession(this.config);

  async loginInteractive(timeoutMs = 180_000): Promise<boolean> {
    await this.session.openLogin();
    console.log(`[boss] 请在普通 Chrome 中完成登录，最多等待 ${Math.round(timeoutMs / 1000)} 秒`);
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await this.session.isLoggedIn().catch(() => false)) {
        await this.session.saveMarker();
        await this.session.warmHome();
        console.log('[boss] 登录有效；Chrome 用户目录已保存在 data/auth（未导出 Cookie）');
        return true;
      }
      await this.sleep(2_000);
    }
    return false;
  }

  protected async ensureReady(): Promise<void> {
    await this.session.ensureOpen();
    // 不在搜索前额外调用 getUserInfo：BOSS 的安全运行时会把连续的自定义请求判为异常。
    // 官方搜索响应本身会明确返回未登录或令牌错误，由 unwrap 统一处理。
  }

  private unwrap<T>(response: BrowserFetchResult<BossApiEnvelope<T>>, operation: string): T {
    const code = response.data?.code;
    const message = response.data?.message || `${operation}失败`;
    if (response.status === 401 || response.status === 403 || code === 37 || code === 1001) {
      throw new AuthRequiredError(this.source, `BOSS 登录态或安全令牌已失效：${message}`);
    }
    if (code === 9 || response.status === 429) throw new RateLimitError(this.source, message);
    if (code === 36) throw new PageStructureError(this.source, `BOSS 风控拦截：${message}；请停止自动访问并回到官网检查账号状态`);
    if (!response.ok || code !== 0 || !response.data.zpData) {
      throw new PageStructureError(this.source, `${operation}异常（HTTP ${response.status} / code ${String(code)}）：${message}`);
    }
    return response.data.zpData;
  }

  protected async searchPage(keyword: string, pageNumber: number, city: string): Promise<RawJob[]> {
    const officialPage = new URL('/web/geek/job', 'https://www.zhipin.com');
    officialPage.searchParams.set('query', keyword);
    officialPage.searchParams.set('city', cityCodeFor(this.source, city));
    officialPage.searchParams.set('page', String(pageNumber));
    const listResponse = await this.session.navigateAndCaptureJson<BossApiEnvelope<{ jobList?: BossListItem[]; lid?: string }>>(
      officialPage.toString(),
      '/wapi/zpgeek/search/joblist.json'
    );
    const listData = this.unwrap(listResponse, `搜索「${keyword}」第 ${pageNumber} 页`);
    const items = Array.isArray(listData.jobList) ? listData.jobList : [];
    const jobs: RawJob[] = [];

    for (const item of items) {
      if (!item.jobName?.trim() || !item.brandName?.trim()) continue;
      const jobId = item.encryptJobId ?? '';
      let jd = item.postDescription ?? '';
      if (jobId) {
        try {
          const detailUrl = new URL(`https://www.zhipin.com/job_detail/${jobId}.html`);
          if (listData.lid) detailUrl.searchParams.set('lid', listData.lid);
          if (item.securityId) detailUrl.searchParams.set('securityId', item.securityId);
          jd = await this.session.navigateAndExtractText(
            detailUrl.toString(),
            ['.job-sec-text', '.job-detail-section .text'],
            20_000
          ) || jd;
          await this.randomDelay();
        } catch (error) {
          console.warn(`[boss] 详情降级为列表数据：${item.jobName}：${(error as Error).message}`);
        }
      }
      const title = item.jobName.trim();
      const company = item.brandName.trim();
      const experience = item.jobExperience;
      const education = item.jobDegree;
      const tags = [...new Set([
        ...stringList(item.skills), ...stringList(item.welfareList),
      ])];
      const recruiterTitle = item.bossTitle?.trim();
      const isHeadhunter = /猎头|寻访顾问|招聘顾问|人才顾问|headhunter/i.test(recruiterTitle ?? '');
      jobs.push({
        title,
        company,
        salary: item.salaryDesc || '',
        location: locationOf(item.cityName, item.areaDistrict),
        source: this.source,
        url: jobId ? `https://www.zhipin.com/job_detail/${jobId}.html` : '',
        jd_fulltext: jd,
        experience,
        education,
        tags,
        recruiter_name: item.bossName?.trim() || undefined,
        recruiter_title: recruiterTitle || undefined,
        is_headhunter: isHeadhunter,
        company_industry: (item.brandIndustryName || item.brandIndustry)?.trim() || undefined,
        company_stage: (item.brandStageName || item.brandStage)?.trim() || undefined,
        company_scale: (item.brandScaleName || item.brandScale)?.trim() || undefined,
      });
    }
    return jobs;
  }
}
