import type { JobSource } from './types.js';

export interface CityCodes { boss: string; liepin?: string; zhaopin?: string }

export const CITY_CODES: Record<string, CityCodes> = {
  北京: { boss: '101010100', liepin: '010', zhaopin: '530' },
  上海: { boss: '101020100', liepin: '020', zhaopin: '538' },
  广州: { boss: '101280100', liepin: '050020', zhaopin: '763' },
  深圳: { boss: '101280600', liepin: '050090', zhaopin: '765' },
  杭州: { boss: '101210100', liepin: '070020', zhaopin: '653' },
  天津: { boss: '101030100', zhaopin: '531' },
  重庆: { boss: '101040100', zhaopin: '551' },
  南京: { boss: '101190100', zhaopin: '635' },
  苏州: { boss: '101190400', zhaopin: '639' },
  成都: { boss: '101270100', zhaopin: '801' },
  武汉: { boss: '101200100', zhaopin: '736' },
  西安: { boss: '101110100', zhaopin: '854' },
  厦门: { boss: '101230200', zhaopin: '682' },
};

export const normalizeCityName = (value: string) => value.trim().replace(/市$/, '');

export function cityCodeFor(source: JobSource, city: string): string {
  const name = normalizeCityName(city);
  const code = CITY_CODES[name]?.[source];
  if (code) return code;
  const supported = Object.entries(CITY_CODES).filter(([, codes]) => codes[source]).map(([item]) => item).join('、');
  throw new Error(`${source} 暂不支持城市“${city}”，当前支持：${supported}`);
}

export function cityNameFromBossCode(code: string): string | undefined {
  return Object.entries(CITY_CODES).find(([, codes]) => codes.boss === code)?.[0];
}
