import { SitespeedioPlugin } from '@sitespeed.io/plugin';
import { getElasticsearchOptions } from './cli.js';
import { flattenMessageData, buildDocument, resolveIndex } from './flatten.js';
import { ElasticsearchSender } from './sender.js';
import type { SitespeedMessage, SitespeedOptions } from './types.js';

const ACCEPTED_TYPES = /\.(pageSummary|summary)$/;

export default class ElasticsearchPlugin extends SitespeedioPlugin {
  static getCliOptions = getElasticsearchOptions;

  private sender: ElasticsearchSender | undefined;

  constructor(options: SitespeedOptions, context: unknown, queue: unknown) {
    super({
      name: 'elasticsearch',
      options,
      context,
      queue
    } as ConstructorParameters<typeof SitespeedioPlugin>[0]);
  }

  override open(_context: unknown, options: SitespeedOptions) {
    const esOpts = options.elasticsearch;

    if (!esOpts?.host) {
      throw new Error('--elasticsearch.host is required');
    }

    this.options = options;
    this.sender = new ElasticsearchSender({
      host: esOpts.host,
      apiKey: esOpts.apiKey,
      username: esOpts.username,
      password: esOpts.password,
      bulkSize: esOpts.bulkSize,
      tlsInsecure: esOpts.tlsInsecure,
      log: this.log
    });

    this.log.info(`Elasticsearch plugin sending to ${esOpts.host}`);
  }

  override async processMessage(message: SitespeedMessage) {
    if (!ACCEPTED_TYPES.test(message.type)) return;
    if (message.group === 'total') return;

    const filterRegistry = this.getFilterRegistry();
    if (filterRegistry) {
      message = filterRegistry.filterMessage(message);
    }

    const flatData = flattenMessageData(message);
    if (Object.keys(flatData).length === 0) return;

    const doc = buildDocument(message, flatData, this.options);
    const index = resolveIndex(
      this.options.elasticsearch.index,
      doc.origin
    );

    await this.sender!.add(index, doc);
  }

  override async close() {
    if (this.sender) {
      await this.sender.close();
      this.log.info('Elasticsearch plugin closed');
    }
  }
}
