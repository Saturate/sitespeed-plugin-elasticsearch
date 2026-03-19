import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@elastic/elasticsearch';
import { ElasticsearchSender } from '../src/sender.js';
import { flattenMessageData, buildDocument, resolveIndex } from '../src/flatten.js';
import type { SitespeedMessage, SitespeedOptions } from '../src/types.js';

const ES_URL = process.env.ELASTICSEARCH_URL;
const ES_API_KEY = process.env.ELASTICSEARCH_API_KEY;
const ES_USERNAME = process.env.ELASTICSEARCH_USERNAME;
const ES_PASSWORD = process.env.ELASTICSEARCH_PASSWORD;

// Unique index per test run to avoid collisions
const TEST_INDEX = `sitespeed-e2e-test-${Date.now()}`;

function getAuthConfig(): { apiKey: string } | { username: string; password: string } | undefined {
  if (ES_API_KEY) return { apiKey: ES_API_KEY };
  if (ES_USERNAME && ES_PASSWORD) return { username: ES_USERNAME, password: ES_PASSWORD };
  return undefined;
}

describe.skipIf(!ES_URL)('e2e: sender → elasticsearch', () => {
  let client: Client;

  beforeAll(() => {
    const auth = getAuthConfig();
    client = new Client({
      node: ES_URL!,
      ...(auth ? { auth } : {}),
      // Don't fail on self-signed certs in test environments
      tls: { rejectUnauthorized: false }
    });
  });

  afterAll(async () => {
    // Clean up test index
    try {
      await client.indices.delete({ index: TEST_INDEX });
    } catch {
      // Index might not exist if tests failed early
    }
    await client.close();
  });

  it('connects to elasticsearch', async () => {
    const info = await client.info();
    expect(info.cluster_name).toBeDefined();
  });

  it('indexes documents via ElasticsearchSender and retrieves them', async () => {
    const log = {
      info: (msg: string) => console.log(`[e2e] ${msg}`),
      warn: (msg: string) => console.warn(`[e2e] ${msg}`),
      error: (msg: string) => console.error(`[e2e] ${msg}`)
    };

    const sender = new ElasticsearchSender({
      host: ES_URL!,
      apiKey: ES_API_KEY,
      username: ES_USERNAME,
      password: ES_PASSWORD,
      bulkSize: 10,
      log
    });

    // Simulate real sitespeed.io messages going through the full pipeline
    const messages: SitespeedMessage[] = [
      {
        type: 'browsertime.pageSummary',
        timestamp: '2024-06-01T12:00:00.000Z',
        url: 'https://example.com/',
        group: 'example.com',
        data: {
          statistics: {
            timings: {
              firstPaint: { median: 320 },
              fullyLoaded: { median: 1850 }
            }
          }
        }
      },
      {
        type: 'lighthouse.pageSummary',
        timestamp: '2024-06-01T12:00:01.000Z',
        url: 'https://example.com/',
        group: 'example.com',
        data: {
          categories: {
            performance: { score: 92 },
            accessibility: { score: 98 }
          }
        }
      },
      {
        type: 'coach.pageSummary',
        timestamp: '2024-06-01T12:00:02.000Z',
        url: 'https://example.com/about',
        group: 'example.com',
        data: {
          advice: {
            performance: { score: 85 },
            bestPractice: { score: 90 }
          }
        }
      }
    ];

    const options: SitespeedOptions = {
      elasticsearch: { host: ES_URL!, index: TEST_INDEX }
    };

    for (const message of messages) {
      const flatData = flattenMessageData(message);
      const doc = buildDocument(message, flatData, options);
      const index = resolveIndex(options.elasticsearch.index, doc.origin);
      await sender.add(index, doc);
    }

    await sender.close();

    // ES needs a refresh before docs are searchable
    await client.indices.refresh({ index: TEST_INDEX });

    // Verify all 3 documents landed
    const count = await client.count({ index: TEST_INDEX });
    expect(count.count).toBe(3);

    // Verify we can search by origin
    const browsertimeHits = await client.search({
      index: TEST_INDEX,
      query: { term: { origin: 'browsertime' } }
    });
    expect(browsertimeHits.hits.hits).toHaveLength(1);

    const btDoc = browsertimeHits.hits.hits[0]._source as Record<string, unknown>;
    expect(btDoc['@timestamp']).toBe('2024-06-01T12:00:00.000Z');
    expect(btDoc.url).toBe('https://example.com/');
    expect(btDoc['statistics.timings.firstPaint.median']).toBe(320);
    expect(btDoc['statistics.timings.fullyLoaded.median']).toBe(1850);

    // Verify lighthouse doc
    const lighthouseHits = await client.search({
      index: TEST_INDEX,
      query: { term: { origin: 'lighthouse' } }
    });
    expect(lighthouseHits.hits.hits).toHaveLength(1);

    const lhDoc = lighthouseHits.hits.hits[0]._source as Record<string, unknown>;
    expect(lhDoc['categories.performance.score']).toBe(92);

    // Verify we can filter by URL
    const aboutHits = await client.search({
      index: TEST_INDEX,
      query: { term: { 'url.keyword': 'https://example.com/about' } }
    });
    expect(aboutHits.hits.hits).toHaveLength(1);
  });

  it('handles bulk flush when buffer fills up', async () => {
    const bulkIndex = `${TEST_INDEX}-bulk`;
    const log = {
      info: () => {},
      warn: (msg: string) => console.warn(`[e2e] ${msg}`),
      error: (msg: string) => console.error(`[e2e] ${msg}`)
    };

    const sender = new ElasticsearchSender({
      host: ES_URL!,
      apiKey: ES_API_KEY,
      username: ES_USERNAME,
      password: ES_PASSWORD,
      bulkSize: 3,
      log
    });

    try {
      // Add 5 docs with bulkSize=3 — should trigger one auto-flush at 3
      for (let i = 0; i < 5; i++) {
        await sender.add(bulkIndex, {
          '@timestamp': new Date().toISOString(),
          origin: 'browsertime',
          summary_type: 'pageSummary',
          iteration: i
        });
      }

      await sender.close();
      await client.indices.refresh({ index: bulkIndex });

      const count = await client.count({ index: bulkIndex });
      expect(count.count).toBe(5);
    } finally {
      try {
        await client.indices.delete({ index: bulkIndex });
      } catch {
        // fine
      }
    }
  });
});
