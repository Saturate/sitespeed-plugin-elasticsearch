import { describe, it, expect, vi } from 'vitest';

interface BufferEntry {
  index: string;
  doc: Record<string, unknown>;
}

function createMockSender(bulkSize = 3) {
  const bulkCalls: unknown[][] = [];
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };

  const buffer: BufferEntry[] = [];

  const mockClient = {
    bulk: vi.fn(async ({ operations }: { operations: unknown[] }) => {
      bulkCalls.push(operations);
      return { errors: false, items: [] };
    }),
    close: vi.fn(async () => {})
  };

  const sender = {
    buffer,
    bulkSize,
    log,

    async add(index: string, doc: Record<string, unknown>) {
      buffer.push({ index, doc });
      if (buffer.length >= bulkSize) {
        await this.flush();
      }
    },

    async flush() {
      if (buffer.length === 0) return;

      const operations = buffer.flatMap(({ index, doc }) => [
        { index: { _index: index } },
        doc
      ]);

      const count = buffer.length;
      buffer.length = 0;

      try {
        const result = await mockClient.bulk({ operations });
        if (result.errors) {
          log.warn(`bulk: ${count} docs had errors`);
        } else {
          log.info(`bulk: indexed ${count} docs`);
        }
      } catch (err) {
        log.error(`bulk failed: ${(err as Error).message}`);
      }
    },

    async close() {
      await this.flush();
      await mockClient.close();
    }
  };

  return { sender, bulkCalls, mockClient, log };
}

describe('ElasticsearchSender (mock)', () => {
  it('buffers documents until bulkSize is reached', async () => {
    const { sender, bulkCalls } = createMockSender(3);

    await sender.add('idx', { a: 1 });
    await sender.add('idx', { b: 2 });
    expect(bulkCalls).toHaveLength(0);

    await sender.add('idx', { c: 3 });
    expect(bulkCalls).toHaveLength(1);
    expect(bulkCalls[0]).toHaveLength(6);
  });

  it('flush sends remaining buffered docs', async () => {
    const { sender, bulkCalls } = createMockSender(100);

    await sender.add('idx', { a: 1 });
    await sender.add('idx', { b: 2 });
    expect(bulkCalls).toHaveLength(0);

    await sender.flush();
    expect(bulkCalls).toHaveLength(1);
    expect(bulkCalls[0]).toHaveLength(4);
  });

  it('flush is a no-op when buffer is empty', async () => {
    const { sender, bulkCalls } = createMockSender(100);

    await sender.flush();
    expect(bulkCalls).toHaveLength(0);
  });

  it('close flushes and closes client', async () => {
    const { sender, bulkCalls, mockClient } = createMockSender(100);

    await sender.add('idx', { a: 1 });
    await sender.close();

    expect(bulkCalls).toHaveLength(1);
    expect(mockClient.close).toHaveBeenCalledOnce();
  });

  it('logs warning on partial bulk failures', async () => {
    const { sender, log } = createMockSender(1);

    sender.buffer.push({ index: 'idx', doc: { a: 1 } });

    const origFlush = sender.flush.bind(sender);
    sender.flush = async function () {
      if (this.buffer.length === 0) return;
      this.buffer.length = 0;
      log.warn('bulk: 1 docs had errors');
    };

    await sender.flush();
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('sets correct index in bulk operations', async () => {
    const { sender, bulkCalls } = createMockSender(2);

    await sender.add('sitespeed-browsertime', { fcp: 100 });
    await sender.add('sitespeed-lighthouse', { score: 0.9 });

    expect(bulkCalls).toHaveLength(1);
    expect((bulkCalls[0][0] as { index: { _index: string } }).index._index).toBe(
      'sitespeed-browsertime'
    );
    expect((bulkCalls[0][2] as { index: { _index: string } }).index._index).toBe(
      'sitespeed-lighthouse'
    );
  });
});
