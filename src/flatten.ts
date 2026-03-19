import type { SitespeedMessage, SitespeedOptions, ElasticsearchDocument } from './types.js';

const SKIP_KEYS = new Set([
  'screenshots',
  'har',
  'visualProgress',
  'VisualProgress'
]);

const SKIP_PREFIXES = ['goog_'];

function shouldSkipKey(key: string): boolean {
  if (SKIP_KEYS.has(key)) return true;
  return SKIP_PREFIXES.some(prefix => key.startsWith(prefix));
}

/**
 * Recursively flatten an object into dot-path keys, keeping only numeric values.
 * Ported from sitespeed.io plugin-influxdb util.js.
 */
export function flattenObject(
  obj: Record<string, unknown>,
  prefix = ''
): Record<string, number> {
  const result: Record<string, number> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (shouldSkipKey(key)) continue;

    const path = prefix ? `${prefix}.${key}` : key;

    if (typeof value === 'number' && Number.isFinite(value)) {
      result[path] = value;
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value as Record<string, unknown>, path));
    }
  }

  return result;
}

export function flattenMessageData(message: SitespeedMessage): Record<string, number> {
  if (!message.data) return {};
  return flattenObject(message.data);
}

export function buildDocument(
  message: SitespeedMessage,
  flatData: Record<string, number>,
  options: SitespeedOptions
): ElasticsearchDocument {
  const timestamp = message.timestamp ?? new Date().toISOString();

  const typeParts = message.type.split('.');
  const origin = typeParts[0];
  const summaryType = typeParts.slice(1).join('.');

  const doc: ElasticsearchDocument = {
    '@timestamp': timestamp,
    origin,
    summary_type: summaryType,
    ...flatData
  };

  if (message.url) {
    doc.url = message.url;
  }

  if (message.group) {
    doc.group = message.group;
  }

  const browserData = options?.browsertime ?? (message.data as Record<string, unknown>)?.browser;
  if (browserData && typeof browserData === 'object') {
    const bd = browserData as Record<string, unknown>;
    if (typeof bd.browser === 'string') {
      doc.browser = bd.browser;
    }
    if (typeof bd.connectivity === 'string') {
      doc.connectivity = bd.connectivity;
    }
  }

  return doc;
}

export function resolveIndex(pattern: string, origin: string): string {
  return pattern.replace('{origin}', origin);
}
