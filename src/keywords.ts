import { z } from 'zod';

/** Spaces within a job title remain intact; separators create independent searches. */
export function splitKeywords(value: string | string[]): string[] {
  return [...new Set((Array.isArray(value) ? value : [value])
    .flatMap((part) => part.split(/[,，、;；\r\n]+/))
    .map((part) => part.trim()).filter(Boolean))];
}

export const KeywordsSchema = z.preprocess(
  (value) => typeof value === 'string' || (Array.isArray(value) && value.every((part) => typeof part === 'string'))
    ? splitKeywords(value) : value,
  z.array(z.string().min(1).max(60)).min(1).max(20),
);
