import { describe, it, expect } from 'vitest';
import {
  flattenObject,
  flattenMessageData,
  buildDocument,
  resolveIndex
} from '../src/flatten.js';
import type { SitespeedMessage, SitespeedOptions } from '../src/types.js';

describe('flattenObject', () => {
  it('flattens nested numeric values into dot paths', () => {
    const result = flattenObject({
      timings: {
        paintTiming: {
          'first-contentful-paint': { median: 850 }
        }
      }
    });

    expect(result).toEqual({
      'timings.paintTiming.first-contentful-paint.median': 850
    });
  });

  it('skips non-numeric values', () => {
    const result = flattenObject({
      name: 'test',
      count: 5,
      active: true
    });

    expect(result).toEqual({ count: 5 });
  });

  it('skips screenshots, har, and visualProgress keys', () => {
    const result = flattenObject({
      screenshots: { data: 123 },
      har: { entries: 456 },
      visualProgress: { '0': 0 },
      VisualProgress: { '0': 0 },
      real: { value: 42 }
    });

    expect(result).toEqual({ 'real.value': 42 });
  });

  it('skips goog_ prefixed keys', () => {
    const result = flattenObject({
      goog_custom_metric: 100,
      normal_metric: 200
    });

    expect(result).toEqual({ normal_metric: 200 });
  });

  it('skips NaN and Infinity', () => {
    const result = flattenObject({
      valid: 1,
      nan: NaN,
      inf: Infinity,
      negInf: -Infinity
    });

    expect(result).toEqual({ valid: 1 });
  });

  it('handles empty object', () => {
    expect(flattenObject({})).toEqual({});
  });

  it('skips arrays', () => {
    const result = flattenObject({
      items: [1, 2, 3],
      count: 3
    });

    expect(result).toEqual({ count: 3 });
  });
});

describe('flattenMessageData', () => {
  it('flattens message.data', () => {
    const result = flattenMessageData({
      type: 'browsertime.pageSummary',
      data: { statistics: { score: 0.95 } }
    });

    expect(result).toEqual({ 'statistics.score': 0.95 });
  });

  it('returns empty object when no data', () => {
    expect(flattenMessageData({ type: 'test' })).toEqual({});
    expect(flattenMessageData({ type: 'test', data: undefined })).toEqual({});
  });
});

describe('buildDocument', () => {
  it('builds a document with required fields', () => {
    const message: SitespeedMessage = {
      type: 'browsertime.pageSummary',
      timestamp: '2024-01-15T10:00:00.000Z',
      url: 'https://example.com/',
      group: 'example.com'
    };

    const doc = buildDocument(message, { 'timings.fcp.median': 850 }, {} as SitespeedOptions);

    expect(doc['@timestamp']).toBe('2024-01-15T10:00:00.000Z');
    expect(doc.origin).toBe('browsertime');
    expect(doc.summary_type).toBe('pageSummary');
    expect(doc.url).toBe('https://example.com/');
    expect(doc.group).toBe('example.com');
    expect(doc['timings.fcp.median']).toBe(850);
  });

  it('handles lighthouse message type', () => {
    const message: SitespeedMessage = {
      type: 'lighthouse.pageSummary',
      timestamp: '2024-01-15T10:00:00.000Z'
    };

    const doc = buildDocument(
      message,
      { 'categories.performance.score': 0.92 },
      {} as SitespeedOptions
    );

    expect(doc.origin).toBe('lighthouse');
    expect(doc.summary_type).toBe('pageSummary');
    expect(doc['categories.performance.score']).toBe(0.92);
  });

  it('omits url and group when not present', () => {
    const message: SitespeedMessage = {
      type: 'coach.summary',
      timestamp: '2024-01-15T10:00:00.000Z'
    };

    const doc = buildDocument(message, { score: 85 }, {} as SitespeedOptions);

    expect(doc.url).toBeUndefined();
    expect(doc.group).toBeUndefined();
  });
});

describe('resolveIndex', () => {
  it('replaces {origin} token', () => {
    expect(resolveIndex('sitespeed-{origin}', 'browsertime')).toBe(
      'sitespeed-browsertime'
    );
  });

  it('returns pattern unchanged when no token', () => {
    expect(resolveIndex('sitespeed', 'browsertime')).toBe('sitespeed');
  });
});
