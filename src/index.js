#!/usr/bin/env node
/**
 * Node.js mirror of the n8n workflow (cron-friendly CLI).
 *
 *   node src/index.js --simulate          offline audit of fixtures/sample-contacts.json (DRY_RUN forced on)
 *   node src/index.js --run [--force]     real audit, gated by AUDIT_INTERVAL_DAYS via data/state.json
 *   node src/index.js --check-config      validate the environment and exit
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadHygieneConfig, validateHygieneConfig } from './core/config.js';
import { createHygieneClients, runAudit } from './core/pipeline.js';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STATE_PATH = path.join(ROOT_DIR, 'data', 'state.json');

export function loadDotEnvFile(filePath = path.join(ROOT_DIR, '.env'), target = process.env) {
  if (!fs.existsSync(filePath)) return false;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    if (target[match[1]] === undefined) target[match[1]] = value;
  }
  return true;
}

export function readState(file = STATE_PATH) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function writeState(state, file = STATE_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export function simulationNow(env = process.env) {
  return Date.parse(`${env.SIMULATE_TODAY || '2026-11-16'}T06:00:00Z`);
}

export async function runSimulation({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = loadHygieneConfig({ ...env, DRY_RUN: 'true', HUBSPOT_PRIVATE_APP_TOKEN: '', SMTP_CHECKER_PROVIDER: env.SMTP_CHECKER_PROVIDER || 'mock' });
  const offlineContacts = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'fixtures', 'sample-contacts.json'), 'utf8'));
  const clients = createHygieneClients(config, { fetchImpl, offlineContacts });
  return runAudit({ config, force: true, fetchImpl, clients, sleep: async () => {}, now: () => simulationNow(env) });
}

/** Persists the completion time only for live, completed runs, so dry runs never delay a real audit. */
export async function runScheduledAudit({ env = process.env, force = false, fetchImpl = globalThis.fetch, stateFile = STATE_PATH } = {}) {
  const config = loadHygieneConfig(env);
  const state = readState(stateFile);
  const result = await runAudit({ config, lastCompletedAt: state.lastAuditCompletedAt, force, fetchImpl });
  if (result.markCompleted && !config.dryRun) writeState({ ...state, lastAuditCompletedAt: result.summary.finishedAt, lastRunId: result.summary.runId }, stateFile);
  return result;
}

async function main(argv) {
  loadDotEnvFile();
  if (argv.includes('--check-config')) {
    const { errors, warnings } = validateHygieneConfig(loadHygieneConfig(process.env));
    warnings.forEach((w) => process.stdout.write(`warning: ${w}\n`));
    errors.forEach((e) => process.stdout.write(`error: ${e}\n`));
    process.stdout.write(errors.length ? 'Configuration invalid.\n' : 'Configuration OK.\n');
    process.exitCode = errors.length ? 1 : 0;
    return;
  }
  if (argv.includes('--simulate')) {
    const result = await runSimulation();
    process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
    process.stdout.write('\nSimulation ran offline with DRY_RUN forced to true and the mock checker. Nothing was written.\n');
    return;
  }
  if (argv.includes('--run')) {
    const result = await runScheduledAudit({ force: argv.includes('--force') });
    process.stdout.write(`${JSON.stringify({ ...result.summary, logDelivery: result.delivery }, null, 2)}\n`);
    process.exitCode = result.summary.status === 'failed' ? 1 : 0;
    return;
  }
  process.stdout.write('Usage: node src/index.js --simulate | --run [--force] | --check-config\n');
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exitCode = 1;
  });
}
