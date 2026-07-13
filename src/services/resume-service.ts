import { existsSync, readFileSync } from 'node:fs';
import { appConfig } from '../config.js';

export const MIN_RESUME_LENGTH = 80;
export const MAX_RESUME_LENGTH = 20_000;

export function readOptionalResume(): string | null {
  if (!existsSync(appConfig.candidateResumePath)) return null;
  const resume = readFileSync(appConfig.candidateResumePath, 'utf8').trim();
  return resume.length >= MIN_RESUME_LENGTH ? resume.slice(0, MAX_RESUME_LENGTH) : null;
}
