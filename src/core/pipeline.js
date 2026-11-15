/**
 * Audit stages shared by the Node.js CLI (src/index.js) and the n8n workflow.
 *
 *   gate -> search -> verify -> decide -> update -> log
 *
 * Each stage takes and returns JSON-serializable data. Stages throw on API
 * failures so n8n can route the error output to "Log Workflow Failure";
 * the Node.js runner catches the same errors and calls failureLog.
 */
import crypto from 'node:crypto';
import { validateHygieneConfig } from './config.js';
import { checkDeliverability } from './deliverability.js';
import { createContactsClient, ENGAGEMENT_DATE_PROPERTIES } from './hubspotContacts.js';
import { buildContactUpdate, decideContact, estimateSavings, evaluateCircuitBreaker, isAuditDue, recentEngagement, recentlyChecked } from './decisions.js';
import { deliverHygieneLog } from './hygieneLog.js';

const DAY_MS = 24 * 3600 * 1000;

export function createHygieneClients(config, { fetchImpl, sleep, offlineContacts } = {}) {
  return {
    hubspot: createContactsClient({
      token: config.hubspot.token,
      dryRun: config.dryRun,
      sandboxMode: config.sandboxMode,
      sandboxPortalId: config.hubspot.sandboxPortalId,
      baseUrl: config.hubspot.baseUrl,
      searchDelayMs: config.hubspot.searchDelayMs,
      fetchImpl,
      ...(sleep ? { sleep } : {}),
      ...(offlineContacts ? { offlineContacts } : {}),
    }),
  };
}

export function gateStage({ config, lastCompletedAt, force = false, now = Date.now() }) {
  const runId = `audit-${new Date(now).toISOString().replace(/[-:]/g, '').slice(0, 15)}-${crypto.randomBytes(3).toString('hex')}`;
  const base = { runId, startedAt: new Date(now).toISOString(), dryRun: config.dryRun, sandboxMode: config.sandboxMode, warnings: [] };
  const { errors, warnings } = validateHygieneConfig(config);
  if (errors.length) return { ...base, status: 'failed', reason: 'config_invalid', errors };
  const gate = isAuditDue({ lastCompletedAt, nowMs: now, intervalDays: config.audit.intervalDays, force });
  return { ...base, warnings, status: gate.due ? 'due' : 'not_due', reason: gate.reason, gate };
}

export async function searchStage(ctx, { config, hubspot, now = Date.now() }) {
  if (ctx.status !== 'due') return ctx;
  const cutoffMs = now - config.audit.staleAfterDays * DAY_MS;
  const { contacts, pages, truncated } = await hubspot.searchAgingContacts({
    cutoffMs,
    onlyMarketingContacts: config.audit.onlyMarketingContacts,
    maxContacts: config.audit.maxContacts,
  });
  let engagedSkipped = 0;
  let recentlyCheckedSkipped = 0;
  const candidates = [];
  for (const c of contacts) {
    if (recentEngagement(c.properties, cutoffMs, ENGAGEMENT_DATE_PROPERTIES)) {
      engagedSkipped += 1;
    } else if (recentlyChecked(c.properties, now, config.audit.recheckAfterDays)) {
      recentlyCheckedSkipped += 1;
    } else {
      candidates.push(c);
    }
  }
  const warnings = [...ctx.warnings];
  if (truncated) warnings.push(`Search capped at MAX_CONTACTS_PER_RUN=${config.audit.maxContacts}; the remainder is picked up next run`);
  return {
    ...ctx,
    status: 'searched',
    staleCutoff: new Date(cutoffMs).toISOString(),
    candidates,
    counts: { searched: contacts.length, searchPages: pages, engagedSkipped, recentlyCheckedSkipped },
    warnings,
  };
}

export async function verifyStage(ctx, { config, fetchImpl, sleep }) {
  if (ctx.status !== 'searched') return ctx;
  const { results, apiCalls, skippedForCap } = await checkDeliverability(ctx.candidates, { checker: config.checker, fetchImpl, ...(sleep ? { sleep } : {}) });
  const warnings = [...ctx.warnings];
  if (skippedForCap) warnings.push(`${skippedForCap} contact(s) not verified: MAX_VERIFICATIONS_PER_RUN reached; they stay unchanged`);
  return { ...ctx, status: 'verified', checks: results, counts: { ...ctx.counts, apiCalls }, warnings };
}

function tally(values) {
  const out = {};
  for (const v of values) out[v] = (out[v] || 0) + 1;
  return out;
}

export function decideStage(ctx, { config, now = Date.now() }) {
  if (ctx.status !== 'verified') return ctx;
  const nowIso = new Date(now).toISOString();
  const decisions = ctx.candidates.map((contact) => ({ id: contact.id, ...decideContact({ contact, emailCheck: ctx.checks[contact.id], titles: config.titles, policy: config.policy }) }));
  const actionable = decisions.filter((d) => d.status);
  const quarantined = actionable.filter((d) => d.status.startsWith('quarantine_'));
  const breaker = evaluateCircuitBreaker({ processed: actionable.length, quarantined: quarantined.length, policy: config.policy });
  let updates = actionable.map((d) => buildContactUpdate({ contactId: d.id, decision: d, nowIso, policy: config.policy }));
  const warnings = [...ctx.warnings];
  if (updates.length > config.policy.maxUpdates) {
    warnings.push(`Updates capped at MAX_UPDATES_PER_RUN=${config.policy.maxUpdates}; ${updates.length - config.policy.maxUpdates} deferred to the next run`);
    updates = updates.slice(0, config.policy.maxUpdates);
  }
  const updatedIds = new Set(updates.map((u) => u.id));
  const nonMarketing = actionable.filter((d) => d.nonMarketing && updatedIds.has(d.id)).length;
  const counts = {
    ...ctx.counts,
    checked: ctx.candidates.length,
    unchanged: decisions.length - actionable.length,
    verified: actionable.filter((d) => d.status === 'verified').length,
    flagged: actionable.filter((d) => d.status.startsWith('flagged_')).length,
    quarantined: quarantined.length,
    exempt: actionable.filter((d) => d.status === 'exempt').length,
    nonMarketing,
    updatesPlanned: breaker.open ? 0 : updates.length,
  };
  return {
    ...ctx,
    status: breaker.open ? 'circuit_open' : 'decided',
    candidates: undefined,
    checks: undefined,
    decisions: decisions.map((d) => ({ id: d.id, status: d.status, reason: d.reason, emailStatus: d.emailStatus, titleMatch: d.title.match, nonMarketing: Boolean(d.nonMarketing) })),
    updates: breaker.open ? [] : updates,
    circuitBreaker: breaker,
    byEmailStatus: tally(decisions.map((d) => d.emailStatus)),
    byHygieneStatus: tally(actionable.map((d) => d.status)),
    savings: estimateSavings({ nonMarketingCount: breaker.open ? 0 : nonMarketing, savings: config.savings }),
    counts,
    warnings,
  };
}

export async function updateStage(ctx, { hubspot }) {
  if (ctx.status !== 'decided') return ctx;
  const result = await hubspot.batchUpdateContacts(ctx.updates);
  return {
    ...ctx,
    status: 'updated',
    update: { mode: result.mode, environment: result.environment || null, batches: result.batches, sample: result.sample },
    counts: { ...ctx.counts, updatesWritten: result.updated || 0 },
    warnings: [...ctx.warnings, ...(result.warnings || [])],
  };
}

export function buildAuditSummary(ctx, { config, now = Date.now() }) {
  const completed = ctx.status === 'updated';
  return {
    runId: ctx.runId,
    startedAt: ctx.startedAt,
    finishedAt: new Date(now).toISOString(),
    status: completed ? 'completed' : ctx.status,
    reason: ctx.reason || (ctx.status === 'circuit_open' ? 'circuit_breaker_open' : null),
    dryRun: ctx.dryRun,
    sandboxMode: ctx.sandboxMode,
    staleAfterDays: config.audit.staleAfterDays,
    staleCutoff: ctx.staleCutoff || null,
    checkerProvider: config.checker.provider,
    marketingStatusWriteMode: config.policy.marketingStatusWriteMode,
    counts: { updatesWritten: 0, ...(ctx.counts || {}) },
    byEmailStatus: ctx.byEmailStatus || {},
    byHygieneStatus: ctx.byHygieneStatus || {},
    circuitBreaker: ctx.circuitBreaker || null,
    savings: ctx.savings || null,
    update: ctx.update || null,
    contactIds: config.log.includeContactIds && ctx.decisions ? ctx.decisions.filter((d) => d.status && d.status !== 'verified').map((d) => ({ id: d.id, status: d.status })) : undefined,
    warnings: ctx.warnings || [],
    errors: ctx.errors || [],
  };
}

export async function logStage(ctx, { config, fetchImpl, now = Date.now() }) {
  const summary = buildAuditSummary(ctx, { config, now });
  let delivery;
  try {
    delivery = await deliverHygieneLog(summary, { config, fetchImpl });
  } catch (err) {
    delivery = { mode: 'failed', code: err.code || null };
    summary.warnings.push(`Log delivery failed: ${String(err.message).slice(0, 200)}`);
  }
  return { summary, delivery, markCompleted: summary.status === 'completed' };
}

/** Used by the n8n error branch and the Node.js runner when a stage throws. */
export async function failureLog(error, { config, runId = null, stage = null, fetchImpl, now = Date.now() }) {
  const summary = {
    runId,
    finishedAt: new Date(now).toISOString(),
    status: 'failed',
    reason: `stage_error${stage ? `:${stage}` : ''}`,
    dryRun: config.dryRun,
    sandboxMode: config.sandboxMode,
    counts: {},
    warnings: [],
    errors: [String((error && (error.code || error.message)) || error).slice(0, 300)],
  };
  let delivery;
  try {
    delivery = await deliverHygieneLog(summary, { config, fetchImpl });
  } catch (err) {
    delivery = { mode: 'failed', code: err.code || null };
  }
  return { summary, delivery, markCompleted: false };
}

/** Node.js mirror of the n8n workflow. */
export async function runAudit({ config, lastCompletedAt, force = false, fetchImpl = globalThis.fetch, clients, sleep, now = () => Date.now() }) {
  const { hubspot } = clients || createHygieneClients(config, { fetchImpl, sleep });
  let ctx = gateStage({ config, lastCompletedAt, force, now: now() });
  if (ctx.status === 'not_due') return { summary: { status: 'not_due', gate: ctx.gate, dryRun: config.dryRun }, delivery: { mode: 'skipped' }, markCompleted: false };
  let stage = 'search';
  try {
    ctx = await searchStage(ctx, { config, hubspot, now: now() });
    stage = 'verify';
    ctx = await verifyStage(ctx, { config, fetchImpl, sleep });
    stage = 'decide';
    ctx = decideStage(ctx, { config, now: now() });
    stage = 'update';
    ctx = await updateStage(ctx, { hubspot });
  } catch (err) {
    return failureLog(err, { config, runId: ctx.runId, stage, fetchImpl, now: now() });
  }
  return logStage(ctx, { config, fetchImpl, now: now() });
}
