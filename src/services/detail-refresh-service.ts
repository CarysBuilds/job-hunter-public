import { getCrawlConfig } from '../config.js';
import { CdpChromeSession, PLATFORM_CDP_OPTIONS, type PlatformCdpOptions } from '../crawlers/cdp-chrome.js';
import { LIEPIN_DETAIL_SELECTORS } from '../crawlers/liepin.js';
import { ZHAOPIN_DETAIL_SELECTORS } from '../crawlers/zhaopin.js';
import type { JobSource, RawJob } from '../types.js';

const MIN_REFRESH_DELAY_MS = 12_000;
const SOURCE_LABELS: Record<JobSource, string> = { boss: 'BOSS', liepin: '猎聘', zhaopin: '智联' };

const DETAIL_CONFIG: Partial<Record<JobSource, { options: PlatformCdpOptions; selectors: string[] }>> = {
  liepin: { options: PLATFORM_CDP_OPTIONS.liepin, selectors: LIEPIN_DETAIL_SELECTORS },
  zhaopin: { options: PLATFORM_CDP_OPTIONS.zhaopin, selectors: ZHAOPIN_DETAIL_SELECTORS },
};

export interface DetailRefresher {
  refresh(job: RawJob): Promise<string>;
}

export class UnsupportedDetailRefreshError extends Error {
  constructor(source: RawJob['source']) {
    super(`暂不支持补全 ${source} 岗位详情`);
    this.name = 'UnsupportedDetailRefreshError';
  }
}

export class BrowserDetailRefresher implements DetailRefresher {
  async refresh(job: RawJob): Promise<string> {
    if (!/^https?:\/\//i.test(job.url)) throw new Error('岗位没有可访问的原始链接');
    const detail = DETAIL_CONFIG[job.source];
    if (!detail) throw new UnsupportedDetailRefreshError(job.source);

    const session = new CdpChromeSession(getCrawlConfig({ pages: 1 }), detail.options);
    const text = await session.navigateAndExtractText(job.url, detail.selectors, 30_000);
    await new Promise((resolve) => setTimeout(resolve, MIN_REFRESH_DELAY_MS));
    if (!text.trim()) throw new Error(`未能从${SOURCE_LABELS[job.source]}详情页提取到岗位描述`);
    return text.trim();
  }
}

let singleton: DetailRefresher | undefined;
export function getDetailRefresher(): DetailRefresher {
  singleton ??= new BrowserDetailRefresher();
  return singleton;
}
