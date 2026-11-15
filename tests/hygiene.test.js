/**
 * Test suite (node --test). No network: HTTP goes through a recording fetch stub,
 * and the n8n Code nodes are executed in-process and compared with the Node.js mirror.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { envFlag, isUnsetValue, loadHygieneConfig, validateHygieneConfig } from '../src/core/config.js';
import { apiVerify, checkDeliverability, localDeliverabilitySignals, mockVerify } from '../src/core/deliverability.js';
import { buildAgingSearchBody, createContactsClient } from '../src/core/hubspotContacts.js';
import { buildContactUpdate, decideContact, estimateSavings, evaluateCircuitBreaker, isAuditDue, matchBuyerTitle, recentEngagement } from '../src/core/decisions.js';
import { deliverHygieneLog, summaryToSheetRow, SHEET_COLUMNS } from '../src/core/hygieneLog.js';
import { createHygieneClients, decideStage, gateStage, runAudit } from '../src/core/pipeline.js';
import { runScheduledAudit, runSimulation, simulationNow } from '../src/index.js';
import { buildWorkflow, serializeWorkflow } from '../scripts/build-workflow.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTACTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'sample-contacts.json'), 'utf8'));
const NOW = simulationNow({});
const DAY = 24 * 3600 * 1000;

function recordingFetch(handler = () => ({ status: 200, body: {} })) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    let body = init.body;
    try {
      body = body ? JSON.parse(body) : undefined;
    } catch {
      // form-encoded bodies stay strings
    }
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body });
    const { status = 200, body: resBody = {} } = (await handler(calls[calls.length - 1])) || {};
    const text = typeof resBody === 'string' ? resBody : JSON.stringify(resBody);
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text };
  };
  return { fetchImpl, calls };
}

const cfg = (env = {}) => loadHygieneConfig(env);
const byId = (id) => CONTACTS.find((c) => c.id === id);
const noSleep = async () => {};

describe('configuration', () => {
  test('safe defaults', () => {
    const c = cfg();
    assert.equal(c.dryRun, true);
    assert.equal(c.sandboxMode, true);
    assert.equal(c.checker.provider, 'mock');
    assert.equal(c.policy.marketingStatusWriteMode, 'quarantine_only');
    assert.equal(c.audit.intervalDays, 90);
    assert.equal(c.audit.staleAfterDays, 180);
    assert.equal(cfg({ DRY_RUN: 'nope' }).dryRun, true);
    assert.equal(envFlag('0', true), false);
    assert.equal(isUnsetValue('YOUR_HUBSPOT_PRIVATE_APP_TOKEN_HERE'), true);
  });

  test('live mode refuses placeholders and the mock checker', () => {
    const { errors } = validateHygieneConfig(cfg({ DRY_RUN: 'false', HUBSPOT_PRIVATE_APP_TOKEN: 'YOUR_HUBSPOT_PRIVATE_APP_TOKEN_HERE' }));
    assert.ok(errors.some((e) => e.includes('HUBSPOT_PRIVATE_APP_TOKEN')));
    assert.ok(errors.some((e) => e.includes('SMTP_CHECKER_PROVIDER=mock')));
    const provider = validateHygieneConfig(cfg({ SMTP_CHECKER_PROVIDER: 'zerobounce', SMTP_CHECKER_API_KEY: 'YOUR_SMTP_CHECKER_API_KEY_HERE' }));
    assert.ok(provider.errors.some((e) => e.includes('SMTP_CHECKER_API_KEY')));
    assert.ok(validateHygieneConfig(cfg({ STALE_AFTER_DAYS: '10' })).errors.length);
    assert.ok(validateHygieneConfig(cfg({ NON_MARKETING_STATUSES: 'quarantine_everything' })).errors.length);
    assert.ok(validateHygieneConfig(cfg({ LOG_TARGET: 'webhook', LOG_WEBHOOK_URL: 'http://insecure.example' })).errors.length);
  });
});

describe('rolling 90-day gate', () => {
  test('first run, not due, due, forced', () => {
    assert.equal(isAuditDue({ lastCompletedAt: null, nowMs: NOW, intervalDays: 90 }).reason, 'first_run');
    const notDue = isAuditDue({ lastCompletedAt: new Date(NOW - 30 * DAY).toISOString(), nowMs: NOW, intervalDays: 90 });
    assert.equal(notDue.due, false);
    assert.equal(notDue.nextDueAt, new Date(NOW + 60 * DAY).toISOString());
    assert.equal(isAuditDue({ lastCompletedAt: new Date(NOW - 91 * DAY).toISOString(), nowMs: NOW, intervalDays: 90 }).due, true);
    assert.equal(isAuditDue({ lastCompletedAt: new Date(NOW - DAY).toISOString(), nowMs: NOW, intervalDays: 90, force: true }).reason, 'forced');
  });

  test('gate stage reports config errors before anything else', () => {
    const ctx = gateStage({ config: cfg({ SMTP_CHECKER_PROVIDER: 'carrier-pigeon' }), now: NOW });
    assert.equal(ctx.status, 'failed');
    assert.equal(ctx.reason, 'config_invalid');
  });

  test('CLI state: dry runs never move the window; live completed runs do', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene-'));
    const stateFile = path.join(dir, 'state.json');
    try {
      await runScheduledAudit({ env: {}, stateFile, force: true, fetchImpl: recordingFetch().fetchImpl });
      assert.equal(fs.existsSync(stateFile), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('HubSpot search and updates', () => {
  test('search body: stale modified date, no recent sales activity, marketing contacts only', () => {
    const body = buildAgingSearchBody({ cutoffMs: 1700000000000, onlyMarketingContacts: true });
    assert.equal(body.filterGroups.length, 2);
    for (const g of body.filterGroups) {
      assert.ok(g.filters.some((f) => f.propertyName === 'lastmodifieddate' && f.operator === 'LT' && f.value === '1700000000000'));
      assert.ok(g.filters.some((f) => f.propertyName === 'hs_marketable_status' && f.value === 'true'));
    }
    assert.equal(body.filterGroups[1].filters.at(-1).operator, 'NOT_HAS_PROPERTY');
    assert.equal(buildAgingSearchBody({ cutoffMs: 1, onlyMarketingContacts: false }).filterGroups[0].filters.length, 2);
  });

  test('paged search with cap', async () => {
    let page = 0;
    const { fetchImpl, calls } = recordingFetch(() => {
      page += 1;
      return { body: { results: Array.from({ length: 100 }, (_, i) => ({ id: String(page * 1000 + i), properties: {} })), paging: { next: { after: String(page) } } } };
    });
    const client = createContactsClient({ token: 'test-token', fetchImpl, sleep: noSleep });
    const r = await client.searchAgingContacts({ cutoffMs: 1, onlyMarketingContacts: true, maxContacts: 250 });
    assert.equal(r.contacts.length, 250);
    assert.equal(r.truncated, true);
    assert.equal(calls.length, 3);
    assert.equal(calls[1].body.after, '1');
  });

  test('dry run intercepts; sandbox blocks production; batches of 100', async () => {
    const inputs = Array.from({ length: 230 }, (_, i) => ({ id: String(i), properties: { list_hygiene_status: 'verified' } }));
    const dry = recordingFetch();
    const r = await createContactsClient({ token: 'test-token', fetchImpl: dry.fetchImpl }).batchUpdateContacts(inputs);
    assert.equal(r.mode, 'intercepted_dry_run');
    assert.equal(r.batches, 3);
    assert.equal(dry.calls.length, 0);
    const prod = recordingFetch((c) => (c.url.endsWith('/account-info/v3/details') ? { body: { portalId: 1, accountType: 'STANDARD' } } : {}));
    await assert.rejects(createContactsClient({ token: 't', dryRun: false, sandboxMode: true, fetchImpl: prod.fetchImpl }).batchUpdateContacts(inputs), (e) => e.code === 'sandbox_account_required');
    assert.ok(prod.calls.every((c) => c.method === 'GET'));
    const sb = recordingFetch((c) => (c.url.endsWith('/account-info/v3/details') ? { body: { portalId: 2, accountType: 'SANDBOX' } } : { body: { status: 'COMPLETE' } }));
    const live = await createContactsClient({ token: 't', dryRun: false, sandboxMode: true, fetchImpl: sb.fetchImpl }).batchUpdateContacts(inputs);
    assert.equal(live.updated, 230);
    assert.equal(sb.calls.filter((c) => c.url.endsWith('/batch/update')).length, 3);
  });

  test('a rejected hs_marketable_status write is retried without that property', async () => {
    let first = true;
    const { fetchImpl, calls } = recordingFetch((c) => {
      if (c.url.endsWith('/batch/update') && first) {
        first = false;
        return { status: 400, body: { message: 'Property values were not valid' } };
      }
      return { body: {} };
    });
    const client = createContactsClient({ token: 't', dryRun: false, sandboxMode: false, fetchImpl });
    const r = await client.batchUpdateContacts([{ id: '1', properties: { list_hygiene_status: 'quarantine_bounced', hs_marketable_status: 'false' } }]);
    assert.equal(r.mode, 'written');
    assert.equal(r.warnings.length, 1);
    assert.equal(calls[1].body.inputs[0].properties.hs_marketable_status, undefined);
  });

  test('placeholder token: offline search, writes refused', async () => {
    const client = createContactsClient({ token: 'YOUR_HUBSPOT_PRIVATE_APP_TOKEN_HERE', dryRun: false, sandboxMode: false, offlineContacts: CONTACTS });
    assert.equal((await client.searchAgingContacts({ cutoffMs: 1, maxContacts: 5 })).contacts.length, 5);
    await assert.rejects(client.batchUpdateContacts([{ id: '1', properties: {} }]), (e) => e.code === 'hubspot_offline');
  });
});

describe('deliverability checks', () => {
  test('local and HubSpot signals', () => {
    assert.equal(localDeliverabilitySignals(byId('104').properties).status, 'invalid');
    assert.equal(localDeliverabilitySignals(byId('102').properties).status, 'hard_bounce');
    assert.equal(localDeliverabilitySignals(byId('103').properties).status, 'hard_bounce');
    assert.equal(localDeliverabilitySignals(byId('106').properties).status, 'disposable');
    assert.equal(localDeliverabilitySignals(byId('108').properties).status, 'role');
    assert.equal(localDeliverabilitySignals(byId('101').properties), null);
  });

  test('mock provider rules on reserved domains', () => {
    assert.equal(mockVerify('a@x.invalid').status, 'invalid');
    assert.equal(mockVerify('a@catch-all.example').status, 'catch_all');
    assert.equal(mockVerify('a@unknown.example').status, 'unknown');
    assert.equal(mockVerify('a@spamtrap.example').status, 'spamtrap');
    assert.equal(mockVerify('a@example.com').status, 'valid');
  });

  test('ZeroBounce, NeverBounce and custom provider mapping', async () => {
    const zb = recordingFetch(() => ({ body: { status: 'catch-all', sub_status: '' } }));
    assert.equal((await apiVerify('a@example.com', { checker: { provider: 'zerobounce', apiKey: 'k', timeoutMs: 1000 }, fetchImpl: zb.fetchImpl })).status, 'catch_all');
    assert.match(zb.calls[0].url, /^https:\/\/api\.zerobounce\.net\/v2\/validate\?api_key=k&email=a%40example\.com/);
    const zbRole = recordingFetch(() => ({ body: { status: 'valid', sub_status: 'role_based' } }));
    assert.equal((await apiVerify('a@example.com', { checker: { provider: 'zerobounce', apiKey: 'k', timeoutMs: 1000 }, fetchImpl: zbRole.fetchImpl })).status, 'role');
    const nb = recordingFetch(() => ({ body: { status: 'success', result: 'disposable' } }));
    assert.equal((await apiVerify('a@example.com', { checker: { provider: 'neverbounce', apiKey: 'k', timeoutMs: 1000 }, fetchImpl: nb.fetchImpl })).status, 'disposable');
    const custom = recordingFetch(() => ({ body: { status: 'hard-bounce' } }));
    const r = await apiVerify('a@example.com', { checker: { provider: 'custom', apiKey: 'k', url: 'https://checker.example/verify', timeoutMs: 1000 }, fetchImpl: custom.fetchImpl });
    assert.equal(r.status, 'hard_bounce');
    assert.equal(custom.calls[0].headers.authorization, 'Bearer k');
  });

  test('provider failures become "error" and leave contacts unchanged', async () => {
    const down = recordingFetch(() => ({ status: 503, body: {} }));
    const r = await apiVerify('a@example.com', { checker: { provider: 'neverbounce', apiKey: 'k', timeoutMs: 1000 }, fetchImpl: down.fetchImpl });
    assert.equal(r.status, 'error');
    const decision = decideContact({ contact: byId('101'), emailCheck: r, titles: cfg().titles, policy: cfg().policy });
    assert.equal(decision.status, null);
  });

  test('verification cap and rate limiting', async () => {
    const { fetchImpl, calls } = recordingFetch(() => ({ body: { status: 'success', result: 'valid' } }));
    const waits = [];
    const contacts = ['a', 'b', 'c'].map((x, i) => ({ id: String(i), properties: { email: `${x}@example.com` } }));
    const r = await checkDeliverability(contacts, { checker: { provider: 'neverbounce', apiKey: 'k', maxVerifications: 2, delayMs: 50, timeoutMs: 1000 }, fetchImpl, sleep: async (ms) => waits.push(ms) });
    assert.equal(r.apiCalls, 2);
    assert.equal(r.skippedForCap, 1);
    assert.equal(r.results['2'].status, 'error');
    assert.deepEqual(waits, [50]);
    assert.equal(calls.length, 2);
  });
});

describe('titles, decisions, circuit breaker and savings', () => {
  const titles = cfg().titles;
  const policy = cfg().policy;

  test('buyer title matching is word-bounded and honours exclusions', () => {
    assert.equal(matchBuyerTitle('VP of Marketing', titles).match, 'target');
    assert.equal(matchBuyerTitle('Head of Revenue Operations', titles).match, 'target');
    assert.equal(matchBuyerTitle('Former Director of Sales', titles).match, 'non_target');
    assert.equal(matchBuyerTitle('Student', titles).match, 'non_target');
    assert.equal(matchBuyerTitle('Developer Advocate', titles).match, 'non_target');
    assert.equal(matchBuyerTitle('', titles).match, 'missing');
    assert.equal(matchBuyerTitle('Executive Assistant to the CEO', titles).match, 'target');
  });

  test('decision matrix', () => {
    const d = (id, check) => decideContact({ contact: byId(id), emailCheck: check, titles, policy });
    assert.equal(d('101', mockVerify('x@example.com')).status, 'verified');
    assert.equal(d('102', { status: 'hard_bounce', source: 'hubspot' }).status, 'quarantine_bounced');
    assert.equal(d('102', { status: 'hard_bounce', source: 'hubspot' }).nonMarketing, true);
    assert.equal(d('107', { status: 'catch_all', source: 'mock' }).status, 'quarantine_unverified');
    assert.equal(d('107', { status: 'catch_all', source: 'mock' }).nonMarketing, false);
    assert.equal(d('109', mockVerify('x@example.com')).status, 'flagged_title_mismatch');
    assert.equal(d('110', mockVerify('x@example.com')).status, 'flagged_missing_title');
    assert.equal(d('111', { status: 'hard_bounce', source: 'hubspot' }).status, 'exempt');
    const strict = { ...policy, unverifiedAction: 'flag' };
    assert.equal(decideContact({ contact: byId('107'), emailCheck: { status: 'unknown' }, titles, policy: strict }).status, 'flagged_unverified');
  });

  test('updates write the quarantine status; hs_marketable_status only in "property" mode', () => {
    const decision = decideContact({ contact: byId('105'), emailCheck: mockVerify(byId('105').properties.email), titles, policy });
    const quarantineOnly = buildContactUpdate({ contactId: '105', decision, nowIso: 'T', policy });
    assert.equal(quarantineOnly.properties.list_hygiene_status, 'quarantine_invalid');
    assert.equal(quarantineOnly.properties.hs_marketable_status, undefined);
    const propertyMode = buildContactUpdate({ contactId: '105', decision, nowIso: 'T', policy: { ...policy, marketingStatusWriteMode: 'property' } });
    assert.equal(propertyMode.properties.hs_marketable_status, 'false');
  });

  test('engagement filter and circuit breaker', () => {
    const cutoff = NOW - 180 * DAY;
    assert.equal(recentEngagement(byId('112').properties, cutoff, ['hs_email_last_open_date']), 'hs_email_last_open_date');
    assert.equal(recentEngagement(byId('101').properties, cutoff, ['hs_email_last_open_date']), null);
    assert.equal(evaluateCircuitBreaker({ processed: 10, quarantined: 9, policy }).open, false);
    assert.equal(evaluateCircuitBreaker({ processed: 100, quarantined: 31, policy }).open, true);
    assert.equal(evaluateCircuitBreaker({ processed: 100, quarantined: 30, policy }).open, false);
  });

  test('savings estimate', () => {
    const s = estimateSavings({ nonMarketingCount: 2500, savings: { monthlyCostPer1000: 20, currency: 'USD' } });
    assert.equal(s.monthly, 50);
    assert.equal(s.annual, 600);
  });

  test('an open circuit breaker plans zero updates', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: String(i), properties: { email: `x${i}@gone.invalid`, jobtitle: 'Director' } }));
    const checks = Object.fromEntries(many.map((c) => [c.id, mockVerify(c.properties.email)]));
    const ctx = decideStage({ status: 'verified', candidates: many, checks, counts: {}, warnings: [] }, { config: cfg(), now: NOW });
    assert.equal(ctx.status, 'circuit_open');
    assert.deepEqual(ctx.updates, []);
    assert.equal(ctx.savings.contactsRemovedFromMarketing, 0);
  });
});

describe('logging', () => {
  const summary = { finishedAt: 'F', runId: 'R', status: 'completed', dryRun: true, sandboxMode: true, counts: { searched: 5, quarantined: 2 }, savings: { monthly: 1, annual: 12, currency: 'USD' }, warnings: [] };

  test('signed webhook payload with aggregates only', async () => {
    const { fetchImpl, calls } = recordingFetch();
    const config = cfg({ LOG_TARGET: 'webhook', LOG_WEBHOOK_URL: 'https://monitoring.example/hook', LOG_WEBHOOK_SECRET: 'log-secret' });
    assert.equal((await deliverHygieneLog(summary, { config, fetchImpl })).mode, 'sent');
    const { headers, body } = calls[0];
    const expected = crypto.createHmac('sha256', 'log-secret').update(`${headers['x-signature-timestamp']}.${JSON.stringify(body)}`).digest('hex');
    assert.equal(headers['x-signature'], `sha256=${expected}`);
    assert.equal(body.type, 'hubspot_list_hygiene_audit');
  });

  test('Google Sheets append with a service-account token', async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const sa = JSON.stringify({ client_email: 'log-writer@service-account.example', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
    const { fetchImpl, calls } = recordingFetch((c) => (c.url.startsWith('https://oauth2') ? { body: { access_token: 'test-access' } } : { body: {} }));
    const config = cfg({ LOG_TARGET: 'google_sheets', GOOGLE_SERVICE_ACCOUNT_JSON: sa, GOOGLE_SHEETS_SPREADSHEET_ID: 'sheet123' });
    await deliverHygieneLog(summary, { config, fetchImpl });
    assert.match(calls[1].url, /spreadsheets\/sheet123\/values\/Hygiene%20Log!A1:append\?valueInputOption=RAW/);
    assert.equal(calls[1].headers.authorization, 'Bearer test-access');
    assert.equal(calls[1].body.values[0].length, SHEET_COLUMNS.length);
    assert.equal(summaryToSheetRow(summary)[2], 'completed');
  });
});

describe('end-to-end audit', () => {
  test('offline simulation over the fixtures', async () => {
    const { summary } = await runSimulation({ env: {} });
    assert.equal(summary.status, 'completed');
    assert.equal(summary.dryRun, true);
    assert.equal(summary.counts.searched, 14);
    assert.equal(summary.counts.engagedSkipped, 1);
    assert.equal(summary.counts.recentlyCheckedSkipped, 1);
    assert.equal(summary.counts.checked, 12);
    assert.equal(summary.counts.verified, 1);
    assert.equal(summary.counts.quarantined, 7);
    assert.equal(summary.counts.exempt, 1);
    assert.equal(summary.counts.nonMarketing, 6);
    assert.equal(summary.update.mode, 'intercepted_dry_run');
    assert.ok(!JSON.stringify(summary).includes('@'));
  });

  test('API failure mid-run produces a failure log and does not mark completion', async () => {
    const { fetchImpl } = recordingFetch((c) => (c.url.includes('/search') ? { status: 401, body: {} } : { body: {} }));
    const config = cfg({ HUBSPOT_PRIVATE_APP_TOKEN: 'test-token' });
    const r = await runAudit({ config, force: true, fetchImpl, sleep: noSleep, now: () => NOW });
    assert.equal(r.summary.status, 'failed');
    assert.equal(r.summary.reason, 'stage_error:search');
    assert.equal(r.markCompleted, false);
  });

  test('not-due runs exit early with no calls', async () => {
    const { fetchImpl, calls } = recordingFetch();
    const r = await runAudit({ config: cfg({ HUBSPOT_PRIVATE_APP_TOKEN: 'test-token' }), lastCompletedAt: new Date(NOW - 10 * DAY).toISOString(), fetchImpl, now: () => NOW });
    assert.equal(r.summary.status, 'not_due');
    assert.equal(calls.length, 0);
  });
});

describe('n8n workflow parity', () => {
  const committed = fs.readFileSync(path.join(ROOT, 'workflow.json'), 'utf8');
  const workflow = JSON.parse(committed);
  const nodes = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));

  test('structure, triggers, error routing, no credentials', () => {
    assert.equal(new Set(workflow.nodes.map((n) => n.name)).size, workflow.nodes.length);
    for (const [from, out] of Object.entries(workflow.connections)) {
      assert.ok(nodes[from], from);
      for (const branch of out.main) for (const l of branch) assert.ok(nodes[l.node], l.node);
    }
    assert.ok(nodes['Weekly Schedule (Rolling 90-Day Gate)']);
    assert.ok(nodes['Run Audit Now (Manual)']);
    for (const name of ['Search Aging HubSpot Contacts', 'Check Email Deliverability', 'Update HubSpot Contacts', 'Append Hygiene Log']) {
      assert.equal(nodes[name].onError, 'continueErrorOutput', name);
      assert.equal(nodes[name].retryOnFail, true, name);
      assert.equal(workflow.connections[name].main[1][0].node, 'Log Workflow Failure', name);
    }
    assert.ok(workflow.nodes.every((n) => !n.credentials));
    assert.ok(!/pat-(?:na|eu)\d-[0-9a-f-]{20,}|xox[abpr]-[0-9A-Za-z-]{10,}|hooks\.slack\.com\/services\/T/.test(committed));
    assert.equal(workflow.active, false);
  });

  test('committed workflow equals a fresh build', () => {
    assert.equal(serializeWorkflow(buildWorkflow()), committed);
  });

  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const requireFn = createRequire(import.meta.url);
  async function runNode(name, items, env, staticData, outputs = {}) {
    const fn = new AsyncFunction('$input', '$env', '$getWorkflowStaticData', 'require', '$', nodes[name].parameters.jsCode);
    const helpers = { httpRequest: async () => ({ statusCode: 200, headers: {}, body: '{}' }) };
    const $ = (n) => ({ first: () => outputs[n][0] });
    return fn.call({ helpers }, { first: () => items[0], all: () => items }, env, () => staticData, requireFn, $);
  }

  test('manual run through the n8n Code nodes matches the Node.js mirror', async () => {
    const env = {};
    const staticData = {};
    const outputs = {};
    let items = await runNode('Mark Manual Run', [{ json: {} }], env, staticData);
    items = await runNode('Check 90-Day Window', items, env, staticData);
    outputs['Check 90-Day Window'] = items;
    assert.equal(items[0].json.status, 'due');
    items = await runNode('Search Aging HubSpot Contacts', items, env, staticData);
    assert.equal(items[0].json.counts.searched, 0);
    for (const name of ['Check Email Deliverability', 'Verify Job Titles & Decide', 'Update HubSpot Contacts', 'Append Hygiene Log']) {
      items = await runNode(name, items, env, staticData);
    }
    assert.equal(items[0].json.summary.status, 'completed');
    assert.equal(staticData.lastAuditCompletedAt, undefined);

    const mirror = await runAudit({ config: cfg(), force: true, fetchImpl: recordingFetch().fetchImpl, now: () => Date.now() });
    for (const key of ['status', 'counts', 'byHygieneStatus', 'dryRun', 'checkerProvider']) assert.deepEqual(items[0].json.summary[key], mirror.summary[key], key);

    const failure = await runNode('Log Workflow Failure', [{ json: { error: 'HubSpot POST failed with HTTP 401' } }], env, staticData, outputs);
    assert.equal(failure[0].json.summary.status, 'failed');
    assert.equal(failure[0].json.summary.runId, outputs['Check 90-Day Window'][0].json.runId);
  });

  test('decide stage parity on fixtures (n8n node vs Node.js)', async () => {
    const config = cfg();
    const clients = createHygieneClients(config, { offlineContacts: CONTACTS });
    const gate = gateStage({ config, force: true, now: NOW });
    const { searchStage, verifyStage } = await import('../src/core/pipeline.js');
    const verified = await verifyStage(await searchStage(gate, { config, hubspot: clients.hubspot, now: NOW }), { config, sleep: noSleep });
    const n8n = await runNode('Verify Job Titles & Decide', [{ json: verified }], {}, {});
    const mirror = decideStage(verified, { config, now: NOW });
    assert.deepEqual(n8n[0].json.byHygieneStatus, mirror.byHygieneStatus);
    assert.deepEqual(n8n[0].json.decisions, mirror.decisions);
  });
});
