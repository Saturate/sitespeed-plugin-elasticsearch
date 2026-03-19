export interface SitespeedMessage {
  type: string;
  timestamp?: string;
  url?: string;
  group?: string;
  data?: Record<string, unknown>;
}

export interface ElasticsearchOptions {
  host: string;
  apiKey?: string;
  username?: string;
  password?: string;
  index: string;
  bulkSize?: number;
}

export interface SitespeedOptions {
  elasticsearch: ElasticsearchOptions;
  browsertime?: {
    browser?: string;
    connectivity?: string;
  };
  [key: string]: unknown;
}

export interface ElasticsearchDocument {
  '@timestamp': string;
  origin: string;
  summary_type: string;
  url?: string;
  group?: string;
  browser?: string;
  connectivity?: string;
  [key: string]: unknown;
}
