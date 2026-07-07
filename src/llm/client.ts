import OpenAI from 'openai';
import { appConfig } from '../config.js';

let client: OpenAI | undefined;
let clientKey = '';

export function getLlmClient(): OpenAI | null {
  const llm = appConfig.llm;
  if (!llm.enabled) return null;
  const nextKey = `${llm.baseURL}|${llm.apiKey}|${llm.timeoutMs}`;
  if (!client || clientKey !== nextKey) {
    client = new OpenAI({
      baseURL: llm.baseURL,
      apiKey: llm.apiKey,
      timeout: llm.timeoutMs,
      maxRetries: 1,
    });
    clientKey = nextKey;
  }
  return client;
}

export function llmStatus(): { configured: boolean; model: string } {
  const llm = appConfig.llm;
  return { configured: llm.enabled, model: llm.model };
}
