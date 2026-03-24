# sitespeed.io plugin for Elasticsearch

Send metrics from sitespeed.io to Elasticsearch. Captures browsertime, lighthouse, coach, and other summary data as flattened numeric documents via the bulk API.

You need sitespeed.io 39.0 or later.

## Install

```bash
npm install sitespeed-plugin-elasticsearch -g
```

## Run

```bash
sitespeed.io --plugins.add sitespeed-plugin-elasticsearch \
  --elasticsearch.host https://localhost:9200 \
  --elasticsearch.apiKey YOUR_API_KEY \
  https://www.example.com
```

## Configuration

```
--elasticsearch.host       Elasticsearch URL (required)
--elasticsearch.apiKey     API key for authentication
--elasticsearch.username   Basic auth username
--elasticsearch.password   Basic auth password
--elasticsearch.index      Index name pattern (default: "sitespeed")
--elasticsearch.bulkSize   Documents buffered before bulk flush (default: 200)
--elasticsearch.tlsInsecure  Disable TLS certificate verification (default: false)
```

Use `{origin}` in the index pattern for per-type indices:

```bash
--elasticsearch.index "sitespeed-{origin}"
```

This creates separate indices like `sitespeed-browsertime`, `sitespeed-lighthouse`, etc.

## What data is sent

The plugin listens for `pageSummary` and `summary` messages and flattens all numeric values into dot-path keys. A browsertime document looks roughly like:

```json
{
  "@timestamp": "2025-01-15T10:00:00.000Z",
  "origin": "browsertime",
  "summary_type": "pageSummary",
  "url": "https://www.example.com/",
  "group": "example.com",
  "statistics.timings.firstPaint.median": 320,
  "statistics.timings.fullyLoaded.median": 1850
}
```

### Document structure

Each document has these metadata fields:

| Field | Description |
|-------|-------------|
| `@timestamp` | When the test ran |
| `origin` | Source plugin: `browsertime`, `coach`, `pagexray`, `thirdparty`, `lighthouse` |
| `summary_type` | `pageSummary` (per-page) or `summary` (aggregated) |
| `url` | Tested URL |
| `group` | Domain grouping |

All numeric metrics are flattened into dot-path keys. Key fields by origin:

**browsertime** — `statistics.timings.firstPaint.median`, `statistics.timings.largestContentfulPaint.renderTime.median`, `statistics.timings.pageTimings.backEndTime.median`, `statistics.timings.fullyLoaded.median`, `statistics.cpu.longTasks.totalBlockingTime.median`, `statistics.pageinfo.cumulativeLayoutShift.median`

**coach** — `advice.performance.score`, `advice.bestpractice.score`, `advice.privacy.score`, `advice.score`, `advice.info.domElements`, `advice.info.domDepth.avg`

**pagexray** — `contentTypes.html.transferSize`, `contentTypes.javascript.transferSize`, `contentTypes.css.transferSize`, `contentTypes.image.transferSize`

We recommend setting `index.mapping.total_fields.limit` to at least `5000` on your ES index, as browsertime produces a large number of flattened fields.

## Development

```bash
pnpm install
pnpm test
```

Test against a real sitespeed.io run:

```bash
pnpm build
npx sitespeed.io -n 1 --plugins.add ./dist/index.js \
  --elasticsearch.host https://localhost:9200 \
  https://www.example.com
```
