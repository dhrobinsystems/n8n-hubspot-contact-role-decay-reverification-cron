#!/usr/bin/env node
/**
 * Generates workflow.json from src/core/.
 *
 * Each stage Code node embeds the same core modules src/index.js imports
 * (imports and `export` keywords stripped) plus a few lines that run one stage.
 * The tests rebuild the workflow, fail if the committed JSON drifts, and execute
 * the Code nodes to compare them with the Node.js mirror.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUT_PATH = path.join(ROOT, 'workflow.json');
export const CORE_MODULES = ['src/core/config.js', 'src/core/deliverability.js', 'src/core/hubspotContacts.js', 'src/core/decisions.js', 'src/core/hygieneLog.js', 'src/core/pipeline.js'];
const PRELUDE_NAMES = ['crypto', 'env', 'config', 'n8nHelpers', 'n8nFetch', 'n8nSleep', 'staticData', 'clients', 'ctx', 'input', 'result', 'runIdFromGate'];
const TOP_LEVEL_DECL = /^(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;

function stripModuleSyntax(source, file) {
  const out = source
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*$/gm, '')
    .replace(/^export\s+(?=(?:async\s+)?(?:function|const|let|class)\s)/gm, '');
  if (/^(?:import|export)\s/m.test(out)) throw new Error(`${file}: unsupported import/export syntax`);
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

export function buildLibrarySource(root = ROOT) {
  const seen = new Map(PRELUDE_NAMES.map((n) => [n, 'n8n prelude']));
  return CORE_MODULES.map((rel) => {
    const body = stripModuleSyntax(fs.readFileSync(path.join(root, rel), 'utf8'), rel);
    for (const m of body.matchAll(TOP_LEVEL_DECL)) {
      if (seen.has(m[1])) throw new Error(`Top-level name "${m[1]}" in ${rel} collides with ${seen.get(m[1])}`);
      seen.set(m[1], rel);
    }
    return `// ---- ${rel} ----\n${body}`;
  }).join('\n\n');
}

const PRELUDE = `
const env = $env;
const config = loadHygieneConfig(env);
const n8nHelpers = this.helpers;
const n8nSleep = (ms) => new Promise((resolve) => (typeof setTimeout === 'function' ? setTimeout(resolve, ms) : resolve()));
const n8nFetch = async (url, init = {}) => {
  const response = await n8nHelpers.httpRequest({
    url,
    method: init.method || 'GET',
    headers: init.headers || {},
    body: init.body,
    json: false,
    returnFullResponse: true,
    ignoreHttpStatusErrors: true,
    timeout: 30000,
  });
  const raw = response.body;
  const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : raw == null ? '' : JSON.stringify(raw);
  return {
    ok: response.statusCode >= 200 && response.statusCode < 300,
    status: response.statusCode,
    headers: { get: (name) => (response.headers || {})[String(name).toLowerCase()] ?? null },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
};
const staticData = $getWorkflowStaticData('global');
const clients = createHygieneClients(config, { fetchImpl: n8nFetch, sleep: n8nSleep });
`;

const STAGES = {
  'Check 90-Day Window': `const input = $input.first().json || {};
const ctx = gateStage({ config, lastCompletedAt: staticData.lastAuditCompletedAt, force: input.force === true, now: Date.now() });
return [{ json: ctx }];`,
  'Search Aging HubSpot Contacts': 'const ctx = await searchStage($input.first().json, { config, hubspot: clients.hubspot, now: Date.now() });\nreturn [{ json: ctx }];',
  'Check Email Deliverability': 'const ctx = await verifyStage($input.first().json, { config, fetchImpl: n8nFetch, sleep: n8nSleep });\nreturn [{ json: ctx }];',
  'Verify Job Titles & Decide': 'const ctx = decideStage($input.first().json, { config, now: Date.now() });\nreturn [{ json: ctx }];',
  'Update HubSpot Contacts': 'const ctx = await updateStage($input.first().json, { hubspot: clients.hubspot });\nreturn [{ json: ctx }];',
  'Append Hygiene Log': `const result = await logStage($input.first().json, { config, fetchImpl: n8nFetch, now: Date.now() });
if (result.markCompleted && !config.dryRun) {
  staticData.lastAuditCompletedAt = result.summary.finishedAt;
  staticData.lastRunId = result.summary.runId;
}
return [{ json: result }];`,
  'Log Workflow Failure': `const input = $input.first().json || {};
let runIdFromGate = null;
try {
  runIdFromGate = $('Check 90-Day Window').first().json.runId;
} catch (gateError) {
  runIdFromGate = null;
}
const result = await failureLog(input.error || input.message || 'unknown error', { config, runId: runIdFromGate, stage: 'n8n', fetchImpl: n8nFetch, now: Date.now() });
return [{ json: result }];`,
};

const id = (n) => `c4e2a9b0-0000-4d00-8b00-${String(n).padStart(12, '0')}`;
const RETRY = { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000 };

const NOTE = `## HubSpot Contact Role-Decay Re-verification (rolling 90-day audit)

Generated from src/core/ by scripts/build-workflow.js. Edit src/core/, run \`npm run build:workflow\`, and re-import.

**Safe by default:** DRY_RUN and SANDBOX_MODE stay true unless set to false. SMTP_CHECKER_PROVIDER=mock sends no email addresses anywhere. MARKETING_STATUS_WRITE_MODE=quarantine_only.

**Schedule:** the trigger fires weekly. "Check 90-Day Window" only lets a run through when AUDIT_INTERVAL_DAYS (90) have passed since the last completed live audit, which gives a rolling quarterly cadence. "Run Audit Now (Manual)" bypasses the gate.

**n8n host:** NODE_FUNCTION_ALLOW_BUILTIN=crypto, N8N_BLOCK_ENV_ACCESS_IN_NODE=false, plus the variables from .env.example.

API stages retry 3 times, then route to "Log Workflow Failure".`;

export function buildWorkflow(root = ROOT) {
  const library = buildLibrarySource(root);
  const header = "// AUTO-GENERATED by scripts/build-workflow.js from src/core/. Edit src/core/, then run `npm run build:workflow`.\nconst crypto = require('crypto');";
  const code = (name, n, position, extra = {}) => ({
    parameters: { jsCode: `${header}\n\n${library}\n\n// ---- n8n stage runner ----${PRELUDE}\n${STAGES[name]}\n` },
    id: id(n),
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
    ...extra,
  });
  const guarded = { ...RETRY, onError: 'continueErrorOutput' };
  const nodes = [
    { parameters: { content: NOTE, height: 420, width: 600 }, id: id(1), name: 'Read Me', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [-120, -520] },
    {
      parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 6 * * 1' }] } },
      id: id(2),
      name: 'Weekly Schedule (Rolling 90-Day Gate)',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [0, 0],
    },
    { parameters: {}, id: id(3), name: 'Run Audit Now (Manual)', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 200] },
    {
      parameters: { jsCode: 'return [{ json: { force: true } }];' },
      id: id(4),
      name: 'Mark Manual Run',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [200, 200],
    },
    code('Check 90-Day Window', 5, [420, 100]),
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
          conditions: [{ id: id(7), leftValue: '={{ $json.status }}', rightValue: 'due', operator: { type: 'string', operation: 'equals' } }],
          combinator: 'and',
        },
        options: {},
      },
      id: id(6),
      name: 'Audit Due?',
      type: 'n8n-nodes-base.if',
      typeVersion: 2,
      position: [640, 100],
    },
    { parameters: {}, id: id(8), name: 'Not Due: Skip Until Next Window', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [860, 260] },
    code('Search Aging HubSpot Contacts', 9, [860, 0], guarded),
    code('Check Email Deliverability', 10, [1080, 0], guarded),
    code('Verify Job Titles & Decide', 11, [1300, 0], { onError: 'continueErrorOutput' }),
    code('Update HubSpot Contacts', 12, [1520, 0], guarded),
    code('Append Hygiene Log', 13, [1740, 0], guarded),
    code('Log Workflow Failure', 14, [1300, 320], RETRY),
  ];
  const link = (node) => ({ node, type: 'main', index: 0 });
  const fail = link('Log Workflow Failure');
  const connections = {
    'Weekly Schedule (Rolling 90-Day Gate)': { main: [[link('Check 90-Day Window')]] },
    'Run Audit Now (Manual)': { main: [[link('Mark Manual Run')]] },
    'Mark Manual Run': { main: [[link('Check 90-Day Window')]] },
    'Check 90-Day Window': { main: [[link('Audit Due?')]] },
    'Audit Due?': { main: [[link('Search Aging HubSpot Contacts')], [link('Not Due: Skip Until Next Window')]] },
    'Search Aging HubSpot Contacts': { main: [[link('Check Email Deliverability')], [fail]] },
    'Check Email Deliverability': { main: [[link('Verify Job Titles & Decide')], [fail]] },
    'Verify Job Titles & Decide': { main: [[link('Update HubSpot Contacts')], [fail]] },
    'Update HubSpot Contacts': { main: [[link('Append Hygiene Log')], [fail]] },
    'Append Hygiene Log': { main: [[], [fail]] },
  };
  return {
    name: 'HubSpot Contact Role-Decay Re-verification (Rolling 90-Day Audit)',
    nodes,
    connections,
    active: false,
    settings: { executionOrder: 'v1', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all', saveManualExecutions: false, timezone: 'UTC' },
    pinData: {},
    meta: { templateCredsSetupCompleted: true },
    tags: [],
  };
}

export function serializeWorkflow(workflow) {
  return `${JSON.stringify(workflow, null, 2)}\n`;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const json = serializeWorkflow(buildWorkflow());
  fs.writeFileSync(OUTPUT_PATH, json);
  process.stdout.write(`Wrote ${path.relative(ROOT, OUTPUT_PATH)} (${(json.length / 1024).toFixed(1)} KiB)\n`);
}
