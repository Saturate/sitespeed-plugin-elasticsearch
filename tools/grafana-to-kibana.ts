#!/usr/bin/env npx tsx
/**
 * Converts a sitespeed.io Grafana dashboard (Graphite datasource)
 * into a Kibana Saved Objects NDJSON file.
 *
 * Usage:
 *   npx tsx tools/grafana-to-kibana.ts <grafana.json> [output.ndjson]
 *
 * The Graphite targets contain a mini function-call AST:
 *   alias($base.$path.$testname.pageSummary.$group.$page.$browser.$connectivity.browsertime.statistics.timings.ttfb.$function, 'TTFB')
 *
 * We parse this AST to extract:
 *   1. The metric path (after $connectivity.)
 *   2. The display label (from alias() arg or aliasByNode index)
 *   3. The origin (browsertime, coach, pagexray, etc.)
 *
 * Then we map Grafana panel types to Kibana Lens visualizations.
 */

import { readFileSync, writeFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Graphite target AST parser
// ---------------------------------------------------------------------------

interface FnCall {
  type: 'fn';
  name: string;
  args: AstNode[];
}

interface PathNode {
  type: 'path';
  value: string;
}

interface StringLiteral {
  type: 'string';
  value: string;
}

interface NumberLiteral {
  type: 'number';
  value: number;
}

type AstNode = FnCall | PathNode | StringLiteral | NumberLiteral;

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    if (input[i] === ' ' || input[i] === '\t' || input[i] === '\n') {
      i++;
      continue;
    }
    if ('(),'.includes(input[i])) {
      tokens.push(input[i]);
      i++;
      continue;
    }
    if (input[i] === "'" || input[i] === '"') {
      const quote = input[i];
      let s = '';
      i++;
      while (i < input.length && input[i] !== quote) {
        s += input[i];
        i++;
      }
      i++; // skip closing quote
      tokens.push(JSON.stringify(s));
      continue;
    }
    // path or number or function name
    let s = '';
    while (i < input.length && !'(), \t\n'.includes(input[i])) {
      s += input[i];
      i++;
    }
    tokens.push(s);
  }
  return tokens;
}

function parse(tokens: string[]): AstNode {
  let pos = 0;

  function parseNode(): AstNode {
    const token = tokens[pos];

    // String literal
    if (token.startsWith('"')) {
      pos++;
      return { type: 'string', value: JSON.parse(token) };
    }

    // Check if next token is '(' → function call
    if (pos + 1 < tokens.length && tokens[pos + 1] === '(') {
      const name = token;
      pos += 2; // skip name and '('
      const args: AstNode[] = [];
      while (tokens[pos] !== ')') {
        if (tokens[pos] === ',') {
          pos++;
          continue;
        }
        args.push(parseNode());
      }
      pos++; // skip ')'
      return { type: 'fn', name, args };
    }

    // Number
    if (/^-?\d+(\.\d+)?$/.test(token)) {
      pos++;
      return { type: 'number', value: Number(token) };
    }

    // Metric path
    pos++;
    return { type: 'path', value: token };
  }

  return parseNode();
}

function parseTarget(target: string): AstNode {
  const tokens = tokenize(target);
  return parse(tokens);
}

// ---------------------------------------------------------------------------
// Extract metric info from parsed AST
// ---------------------------------------------------------------------------

interface MetricInfo {
  /** Full path after $connectivity, e.g. "browsertime.statistics.timings.ttfb.median" */
  fullPath: string;
  /** The ES field name (origin prefix stripped for pageSummary docs) */
  esField: string;
  /** Origin: browsertime, coach, pagexray, thirdparty, etc. */
  origin: string;
  /** Display label extracted from alias() */
  label: string;
  /** Whether this path contains wildcards */
  hasWildcard: boolean;
  /** The $function variable (median by default) */
  statFunction: string;
}

/** Strip the variable prefix up to and including $connectivity */
function extractMetricPath(path: string): string | null {
  const marker = '$connectivity.';
  const idx = path.indexOf(marker);
  if (idx >= 0) {
    return path.slice(idx + marker.length);
  }
  return null;
}

/**
 * Check if a Graphite path is from a pageSummary context (not per-run).
 * Per-run targets have `.run.` in the variable prefix, pageSummary targets
 * have `.pageSummary.` — we only index pageSummary/summary messages.
 */
function isPageSummaryTarget(rawPath: string): boolean {
  // If it explicitly has .run. in the path, it's per-run data
  if (rawPath.includes('.run.')) return false;
  return true;
}

/**
 * Check if a metric path points to aggregated statistics (has .statistics. or
 * is from a non-browsertime origin which always sends aggregated data).
 * Raw per-iteration paths like browsertime.timings.ttfb don't exist in our ES.
 */
function isStatisticsPath(metricPath: string): boolean {
  const origin = getOrigin(metricPath);
  // Non-browsertime origins (coach, pagexray, thirdparty) always have flat data
  if (origin !== 'browsertime') return true;
  // Browsertime pageSummary data always lives under .statistics.
  const afterOrigin = metricPath.slice(origin.length + 1);
  return afterOrigin.startsWith('statistics.');
}

/** Determine origin from the metric path */
function getOrigin(metricPath: string): string {
  const first = metricPath.split('.')[0];
  // Map known origins
  const origins = ['browsertime', 'coach', 'pagexray', 'thirdparty', 'axe', 'sustainable', 'lighthouse'];
  if (origins.includes(first)) return first;
  return 'browsertime';
}

/**
 * Map Graphite metric path to our ES field name.
 * In ES, the origin is stored in the `origin` field, and the metrics
 * are flattened without the origin prefix but with 'statistics.' prefix for pageSummary.
 */
function toEsField(metricPath: string, statFn: string): string {
  const origin = getOrigin(metricPath);

  // Strip the origin prefix
  let field = metricPath;
  if (field.startsWith(origin + '.')) {
    field = field.slice(origin.length + 1);
  }

  // Replace $function with the actual stat function
  field = field.replace('$function', statFn);

  return field;
}

function extractLabel(ast: AstNode, metricPath: string): string {
  if (ast.type === 'fn' && ast.name === 'alias' && ast.args.length >= 2) {
    const labelArg = ast.args[1];
    if (labelArg.type === 'string') return labelArg.value;
  }
  if (ast.type === 'fn' && ast.name === 'aliasByNode' && ast.args.length >= 2) {
    const indexArg = ast.args[1];
    if (indexArg.type === 'number') {
      const parts = metricPath.split('.');
      if (indexArg.value < parts.length) return parts[indexArg.value];
    }
  }
  // Fallback: use last meaningful path segment
  const parts = metricPath.split('.');
  return parts.filter(p => !p.startsWith('$')).pop() ?? metricPath;
}

function getFirstPath(ast: AstNode): string | null {
  if (ast.type === 'path') return ast.value;
  if (ast.type === 'fn') {
    for (const arg of ast.args) {
      const p = getFirstPath(arg);
      if (p) return p;
    }
  }
  return null;
}

function analyzeTarget(target: string, defaultStatFn = 'median'): MetricInfo | null {
  const ast = parseTarget(target);
  const rawPath = getFirstPath(ast);
  if (!rawPath) return null;

  // Skip per-run targets — we only index pageSummary/summary
  if (!isPageSummaryTarget(rawPath)) return null;

  const metricPath = extractMetricPath(rawPath);
  if (!metricPath) return null;

  // Skip raw browsertime paths (no .statistics.) — they're per-iteration
  if (!isStatisticsPath(metricPath)) return null;

  const hasWildcard = metricPath.includes('*');
  const origin = getOrigin(metricPath);
  const esField = toEsField(metricPath, defaultStatFn);
  const label = extractLabel(ast, metricPath);

  return {
    fullPath: metricPath,
    esField,
    origin,
    label,
    hasWildcard,
    statFunction: defaultStatFn,
  };
}

// ---------------------------------------------------------------------------
// Grafana → Kibana panel mapping
// ---------------------------------------------------------------------------

interface GrafanaPanel {
  type: string;
  title: string;
  id?: number;
  targets?: Array<{ target: string; refId?: string }>;
  panels?: GrafanaPanel[];
  gridPos?: { x: number; y: number; w: number; h: number };
}

interface KibanaPanel {
  version: string;
  type: string;
  gridData: { x: number; y: number; w: number; h: number; i: string };
  panelIndex: string;
  embeddableConfig: Record<string, unknown>;
  title?: string;
}

let panelCounter = 0;
function nextPanelId(prefix: string): string {
  return `${prefix}-${++panelCounter}`;
}

const DATA_VIEW_ID = 'sitespeed-data-view';

function buildLensMetric(
  id: string,
  title: string,
  label: string,
  esField: string,
  origin: string,
  color: string,
  gridData: { x: number; y: number; w: number; h: number },
): KibanaPanel {
  return {
    version: '8.18.0',
    type: 'lens',
    gridData: { ...gridData, i: id },
    panelIndex: id,
    embeddableConfig: {
      attributes: {
        title,
        visualizationType: 'lnsMetric',
        state: {
          datasourceStates: {
            formBased: {
              layers: {
                layer1: {
                  columnOrder: ['col1'],
                  columns: {
                    col1: {
                      label,
                      dataType: 'number',
                      operationType: 'last_value',
                      sourceField: esField,
                      params: { sortField: '@timestamp' },
                    },
                  },
                  incompleteColumns: {},
                },
              },
            },
          },
          visualization: {
            layerId: 'layer1',
            layerType: 'data',
            metricAccessor: 'col1',
            color,
          },
          query: {
            query: `origin: ${origin} AND summary_type: pageSummary`,
            language: 'kuery',
          },
          filters: [],
        },
        references: [
          { type: 'index-pattern', id: DATA_VIEW_ID, name: 'indexpattern-datasource-layer-layer1' },
        ],
      },
    },
  };
}

function buildLensTimeseries(
  id: string,
  title: string,
  metrics: Array<{ colId: string; label: string; esField: string }>,
  origin: string,
  gridData: { x: number; y: number; w: number; h: number },
  seriesType = 'line',
  yTitle = 'ms',
): KibanaPanel {
  const columns: Record<string, unknown> = {
    'col-date': {
      label: 'Timestamp',
      dataType: 'date',
      operationType: 'date_histogram',
      sourceField: '@timestamp',
      params: { interval: 'auto' },
    },
  };
  const columnOrder = ['col-date'];
  const accessors: string[] = [];

  for (const m of metrics) {
    columns[m.colId] = {
      label: m.label,
      dataType: 'number',
      operationType: 'last_value',
      sourceField: m.esField,
      params: { sortField: '@timestamp' },
    };
    columnOrder.push(m.colId);
    accessors.push(m.colId);
  }

  return {
    version: '8.18.0',
    type: 'lens',
    gridData: { ...gridData, i: id },
    panelIndex: id,
    embeddableConfig: {
      attributes: {
        title,
        visualizationType: 'lnsXY',
        state: {
          datasourceStates: {
            formBased: {
              layers: {
                layer1: { columnOrder, columns, incompleteColumns: {} },
              },
            },
          },
          visualization: {
            layerId: 'layer1',
            layerType: 'data',
            legend: { isVisible: true, position: 'right' },
            preferredSeriesType: seriesType,
            yTitle,
            layers: [
              {
                layerId: 'layer1',
                accessors,
                xAccessor: 'col-date',
                seriesType,
                layerType: 'data',
              },
            ],
          },
          query: {
            query: `origin: ${origin} AND summary_type: pageSummary`,
            language: 'kuery',
          },
          filters: [],
        },
        references: [
          { type: 'index-pattern', id: DATA_VIEW_ID, name: 'indexpattern-datasource-layer-layer1' },
        ],
      },
    },
  };
}

function buildSectionHeader(
  id: string,
  title: string,
  gridData: { x: number; y: number; w: number; h: number },
): KibanaPanel {
  return {
    version: '8.18.0',
    type: 'visualization',
    gridData: { ...gridData, i: id },
    panelIndex: id,
    embeddableConfig: {
      savedVis: {
        title,
        type: 'markdown',
        params: {
          fontSize: 12,
          openLinksInNewTab: false,
          markdown: `## ${title}`,
        },
        data: {
          aggs: [],
          searchSource: {
            query: { query: '', language: 'kuery' },
            filter: [],
          },
        },
      },
    },
  };
}

// Colors for metric cards
const COLORS = [
  '#54B399', '#6092C0', '#D36086', '#DA8B45',
  '#B9A888', '#9170B8', '#CA8EAE', '#D6BF57',
  '#E7664C', '#AA6556',
];

// ---------------------------------------------------------------------------
// Main conversion: walk Grafana panels, emit Kibana panels
// ---------------------------------------------------------------------------

interface LayoutState {
  x: number;
  y: number;
}

function convertGrafanaDashboard(grafanaJson: Record<string, unknown>): {
  panels: KibanaPanel[];
  title: string;
  description: string;
} {
  const grafanaPanels = (grafanaJson.panels ?? []) as GrafanaPanel[];
  const dashTitle = (grafanaJson.title as string) ?? 'sitespeed.io - Page Metrics';
  const dashDesc = (grafanaJson.description as string) ?? 'Web performance metrics from sitespeed.io';

  const kibanaPanels: KibanaPanel[] = [];
  const layout: LayoutState = { x: 0, y: 0 };
  let colorIdx = 0;

  function nextColor(): string {
    return COLORS[colorIdx++ % COLORS.length];
  }

  function processPanel(panel: GrafanaPanel) {
    const panelType = panel.type;
    const title = panel.title || 'untitled';
    const targets = panel.targets ?? [];

    // Skip text-only panels (screenshots, videos, etc.)
    if (panelType === 'text' || panelType === 'marcusolsson-dynamictext-panel') {
      return;
    }

    // Row → section header
    if (panelType === 'row') {
      // Add a markdown section header
      const headerId = nextPanelId('section');
      kibanaPanels.push(
        buildSectionHeader(headerId, title, { x: 0, y: layout.y, w: 48, h: 3 }),
      );
      layout.y += 2;
      layout.x = 0;

      // Process collapsed panels inside the row
      for (const sub of panel.panels ?? []) {
        processPanel(sub);
      }
      return;
    }

    // Parse all targets to get metric info
    const metrics = targets
      .map(t => analyzeTarget(t.target))
      .filter((m): m is MetricInfo => m !== null && !m.hasWildcard);

    if (metrics.length === 0) return;

    const primaryOrigin = metrics[0].origin;

    // Determine the right summary_type query based on the origin
    function queryForOrigin(origin: string): string {
      return `origin: ${origin} AND summary_type: pageSummary`;
    }

    // Stat panels → Kibana metric cards
    if (panelType === 'stat' || panelType === 'gauge' || panelType === 'singlestat') {
      for (const m of metrics) {
        const id = nextPanelId('stat');
        if (layout.x + 8 > 48) {
          layout.x = 0;
          layout.y += 6;
        }
        kibanaPanels.push(
          buildLensMetric(
            id,
            m.label,
            m.label,
            m.esField,
            m.origin,
            nextColor(),
            { x: layout.x, y: layout.y, w: 8, h: 6 },
          ),
        );
        layout.x += 8;
      }
      return;
    }

    // Timeseries / graph panels → Kibana Lens XY
    if (panelType === 'timeseries' || panelType === 'graph') {
      // Start new row if needed
      if (layout.x !== 0) {
        layout.x = 0;
        layout.y += 6;
      }

      const id = nextPanelId('ts');
      const lensMetrics = metrics.map((m, i) => ({
        colId: `col-${i}`,
        label: m.label,
        esField: m.esField,
      }));

      // Use the width from Grafana if available, otherwise full width
      const w = panel.gridPos?.w ? Math.round(panel.gridPos.w * 2) : 48;
      const clampedW = Math.min(w, 48);

      kibanaPanels.push(
        buildLensTimeseries(
          id,
          title,
          lensMetrics,
          primaryOrigin,
          { x: 0, y: layout.y, w: clampedW, h: 12 },
          'line',
          'ms',
        ),
      );
      layout.y += 12;
      return;
    }

    // Piechart → skip for now (Kibana Lens pie is possible but different)
    if (panelType === 'piechart') {
      return;
    }
  }

  for (const panel of grafanaPanels) {
    processPanel(panel);
  }

  return { panels: kibanaPanels, title: dashTitle, description: dashDesc };
}

// ---------------------------------------------------------------------------
// Generate NDJSON output
// ---------------------------------------------------------------------------

function generateNdjson(
  panels: KibanaPanel[],
  title: string,
  description: string,
): string {
  const dataView = {
    attributes: {
      fieldAttrs: '{}',
      fieldFormatMap: '{}',
      fields: '[]',
      name: 'sitespeed.io',
      runtimeFieldMap: '{}',
      sourceFilters: '[]',
      timeFieldName: '@timestamp',
      title: 'sitespeed-*',
      typeMeta: '{}',
    },
    id: DATA_VIEW_ID,
    managed: false,
    references: [],
    type: 'index-pattern',
    typeMigrationVersion: '8.0.0',
  };

  const dashboard = {
    attributes: {
      description,
      kibanaSavedObjectMeta: {
        searchSourceJSON: JSON.stringify({
          query: { query: '', language: 'kuery' },
          filter: [],
        }),
      },
      optionsJSON: JSON.stringify({
        useMargins: true,
        syncColors: false,
        syncCursor: true,
        syncTooltips: false,
        hidePanelTitles: false,
      }),
      panelsJSON: JSON.stringify(panels),
      timeRestore: true,
      timeTo: 'now',
      timeFrom: 'now-7d',
      title,
      version: 2,
    },
    id: 'sitespeed-dashboard',
    managed: false,
    references: [
      {
        id: DATA_VIEW_ID,
        name: 'indexpattern-datasource-layer-layer1',
        type: 'index-pattern',
      },
    ],
    type: 'dashboard',
    typeMigrationVersion: '8.9.0',
  };

  return [JSON.stringify(dataView), JSON.stringify(dashboard)].join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: npx tsx tools/grafana-to-kibana.ts <grafana.json> [output.ndjson]');
  process.exit(1);
}

const inputFile = args[0];
const outputFile = args[1] ?? 'dashboards/kibana-dashboard.ndjson';

const grafanaJson = JSON.parse(readFileSync(inputFile, 'utf-8'));
const { panels, title, description } = convertGrafanaDashboard(grafanaJson);

const ndjson = generateNdjson(panels, title, description);
writeFileSync(outputFile, ndjson);

console.log(`Converted ${panels.length} panels from "${title}"`);
console.log(`Output: ${outputFile}`);

// Print summary
const types: Record<string, number> = {};
for (const p of panels) {
  const vizType =
    (p.embeddableConfig?.attributes as Record<string, unknown>)?.visualizationType as string
    ?? p.type;
  types[vizType] = (types[vizType] ?? 0) + 1;
}
console.log('\nPanel breakdown:');
for (const [t, count] of Object.entries(types)) {
  console.log(`  ${t}: ${count}`);
}
