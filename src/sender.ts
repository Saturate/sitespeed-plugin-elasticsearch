import { Client } from '@elastic/elasticsearch';

interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

interface SenderOptions {
  host: string;
  apiKey?: string;
  username?: string;
  password?: string;
  bulkSize?: number;
  tlsInsecure?: boolean;
  log: Logger;
}

interface BufferEntry {
  index: string;
  doc: Record<string, unknown>;
}

export class ElasticsearchSender {
  private client: Client;
  private buffer: BufferEntry[] = [];
  private bulkSize: number;
  private log: Logger;

  constructor({ host, apiKey, username, password, bulkSize = 200, tlsInsecure, log }: SenderOptions) {
    const clientOpts: ConstructorParameters<typeof Client>[0] = { node: host };

    if (apiKey) {
      clientOpts.auth = { apiKey };
    } else if (username && password) {
      clientOpts.auth = { username, password };
    }

    if (tlsInsecure) {
      clientOpts.tls = { rejectUnauthorized: false };
    }

    this.client = new Client(clientOpts);
    this.bulkSize = bulkSize;
    this.log = log;
  }

  async add(index: string, doc: Record<string, unknown>): Promise<void> {
    this.buffer.push({ index, doc });

    if (this.buffer.length >= this.bulkSize) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const operations = this.buffer.flatMap(({ index, doc }) => [
      { index: { _index: index } },
      doc
    ]);

    const count = this.buffer.length;
    this.buffer = [];

    try {
      const result = await this.client.bulk({ operations });

      if (result.errors) {
        const failed = result.items.filter(item => item.index?.error);
        this.log.warn(
          `Elasticsearch bulk: ${failed.length}/${count} docs failed`
        );
        for (const item of failed.slice(0, 3)) {
          this.log.warn(
            `  ${item.index?.error?.type}: ${item.index?.error?.reason}`
          );
        }
      } else {
        this.log.info(`Elasticsearch bulk: indexed ${count} docs`);
      }
    } catch (err) {
      this.log.error(`Elasticsearch bulk request failed: ${(err as Error).message}`);
    }
  }

  async close(): Promise<void> {
    await this.flush();
    await this.client.close();
  }
}
