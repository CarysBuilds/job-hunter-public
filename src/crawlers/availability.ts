export const EXPIRED_JOB_SIGNAL_SOURCE = [
  String.raw`(?:职位|岗位|招聘)(?:已)?(?:下线|关闭|过期|失效|结束|招满|停止|暂停|下架)`,
  String.raw`(?:已|停止|暂停)(?:招聘|招募)`,
  String.raw`招聘(?:已)?(?:结束|截止|关闭|暂停)`,
  String.raw`(?:职位|岗位)(?:不存在|已删除)`,
  String.raw`页面不存在|404|expired|closed|offline`,
].join('|');

const EXPIRED_JOB_SIGNAL_PATTERN = new RegExp(EXPIRED_JOB_SIGNAL_SOURCE, 'i');

export class JobUnavailableError extends Error {
  constructor(message = '岗位已失效或招聘已结束') {
    super(message);
    this.name = 'JobUnavailableError';
  }
}

export function hasExpiredJobSignal(value: string): boolean {
  return EXPIRED_JOB_SIGNAL_PATTERN.test(value.replace(/\s+/g, ' '));
}

export function isExpiredJobError(error: unknown): boolean {
  return error instanceof JobUnavailableError
    || /岗位已失效|招聘已结束|职位已下线|岗位已下线|职位不存在|岗位不存在|页面不存在|已停止招聘/.test((error as Error).message || String(error));
}
