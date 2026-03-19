export function getElasticsearchOptions() {
  return {
    elasticsearch: {
      host: {
        describe: 'Elasticsearch URL',
        group: 'Elasticsearch'
      },
      apiKey: {
        describe: 'Elasticsearch API key for authentication',
        group: 'Elasticsearch'
      },
      username: {
        describe: 'Elasticsearch basic auth username',
        group: 'Elasticsearch'
      },
      password: {
        describe: 'Elasticsearch basic auth password',
        group: 'Elasticsearch'
      },
      index: {
        default: 'sitespeed',
        describe:
          'Index name pattern. Use {origin} for per-type indices (e.g. "sitespeed-{origin}")',
        group: 'Elasticsearch'
      },
      bulkSize: {
        default: 200,
        describe: 'Number of documents buffered before a bulk flush',
        type: 'number',
        group: 'Elasticsearch'
      }
    }
  };
}
