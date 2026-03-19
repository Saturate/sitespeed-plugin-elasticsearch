declare module '@sitespeed.io/plugin' {
  type SitespeedMessage = import('./src/types.js').SitespeedMessage;
  type SitespeedOptions = import('./src/types.js').SitespeedOptions;

  interface PluginConfig {
    name: string;
    options: SitespeedOptions;
    context: {
      messageMaker(name: string): { make: (...args: unknown[]) => unknown };
      getLogger(name: string): PluginLogger;
      filterRegistry?: {
        filterMessage(message: SitespeedMessage): SitespeedMessage;
      };
      storageManager?: unknown;
    };
    queue: {
      postMessage(message: unknown): Promise<void>;
    };
  }

  interface PluginLogger {
    trace(message: string, ...args: unknown[]): void;
    verbose(message: string, ...args: unknown[]): void;
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
    critical(message: string, ...args: unknown[]): void;
  }

  export class SitespeedioPlugin {
    name: string;
    options: SitespeedOptions;
    context: PluginConfig['context'];
    queue: PluginConfig['queue'];
    make: (...args: unknown[]) => unknown;
    log: PluginLogger;

    constructor(config: PluginConfig);
    getFilterRegistry(): PluginConfig['context']['filterRegistry'];
    getName(): string;
    getOptions(): SitespeedOptions;
    getContext(): PluginConfig['context'];
    getStorageManager(): unknown;
    open(context: unknown, options: SitespeedOptions): void | Promise<void>;
    processMessage(message: SitespeedMessage): void | Promise<void>;
    close(): void | Promise<void>;
    sendMessage(type: string, data: unknown, extras?: unknown): Promise<void>;
    static getCliOptions?: () => Record<string, unknown>;
  }
}

declare module '@sitespeed.io/log' {
  interface Logger {
    trace(message: string, ...args: unknown[]): void;
    verbose(message: string, ...args: unknown[]): void;
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
    critical(message: string, ...args: unknown[]): void;
  }

  export function getLogger(name: string): Logger;
  export function configureLog(options: unknown): void;
  export { Logger };
}
