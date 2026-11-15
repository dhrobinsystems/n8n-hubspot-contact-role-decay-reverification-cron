/**
 * Audit summary logging: a signed JSON webhook (n8n, Make, Slack-compatible relay,
 * a database endpoint) or a Google Sheets row via a service account. Log payloads
 * hold aggregate counts only. Contact IDs are included only with
 * LOG_INCLUDE_CONTACT_IDS=true, and emails never.
 */
import crypto from 'node:crypto';
import { isUnsetValue } from './config.js';

export const SHEET_COLUMNS = [
  'finished_at', 'run_id', 'status', 'dry_run', 'sandbox_mode', 'searched', 'engaged_skipped', 'recently_checked_skipped',
  'checked', 'verified', 'flagged', 'quarantined', 'exempt', 'non_marketing', 'updates_written', 'monthly_savings',
  'annual_savings', 'currency', 'notes',
];

export function summaryToSheetRow(summary) {
  const c = summary.counts || {};
  const notes = [summary.reason, summary.circuitBreaker && summary.circuitBreaker.open ? `circuit breaker: ${summary.circuitBreaker.detail}` : null, ...(summary.warnings || [])]
    .filter(Boolean)
    .join(' | ')
    .slice(0, 1000);
  return [
    summary.finishedAt, summary.runId, summary.status, String(summary.dryRun), String(summary.sandboxMode), c.searched ?? 0,
    c.engagedSkipped ?? 0, c.recentlyCheckedSkipped ?? 0, c.checked ?? 0, c.verified ?? 0, c.flagged ?? 0, c.quarantined ?? 0,
    c.exempt ?? 0, c.nonMarketing ?? 0, c.updatesWritten ?? 0, summary.savings ? summary.savings.monthly : 0,
    summary.savings ? summary.savings.annual : 0, summary.savings ? summary.savings.currency : '', notes,
  ];
}

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export async function googleServiceAccountToken({ serviceAccountJson, scope, fetchImpl, nowMs = Date.now() }) {
  let key;
  try {
    key = JSON.parse(serviceAccountJson);
  } catch {
    throw Object.assign(new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON'), { code: 'google_credentials_invalid' });
  }
  if (!key.client_email || !key.private_key) throw Object.assign(new Error('Service account JSON needs client_email and private_key'), { code: 'google_credentials_invalid' });
  const iat = Math.floor(nowMs / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iss: key.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }))}`;
  const assertion = `${unsigned}.${b64url(crypto.createSign('RSA-SHA256').update(unsigned).sign(key.private_key))}`;
  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(assertion)}`,
  });
  if (!response.ok) throw Object.assign(new Error(`Google token endpoint returned HTTP ${response.status}`), { code: 'google_auth_failed' });
  return JSON.parse(await response.text()).access_token;
}

/** Delivers the summary. Dry runs are logged too (flagged dryRun: true), since the payload holds aggregates only. */
export async function deliverHygieneLog(summary, { config, fetchImpl }) {
  const log = config.log;
  if (log.target === 'none') return { mode: 'not_configured' };
  if (log.target === 'webhook') {
    const body = JSON.stringify({ type: 'hubspot_list_hygiene_audit', summary });
    const headers = { 'content-type': 'application/json' };
    if (!isUnsetValue(log.webhookSecret)) {
      const ts = String(Math.floor(Date.now() / 1000));
      headers['x-signature-timestamp'] = ts;
      headers['x-signature'] = `sha256=${crypto.createHmac('sha256', log.webhookSecret).update(`${ts}.${body}`).digest('hex')}`;
    }
    const response = await fetchImpl(log.webhookUrl, { method: 'POST', headers, body });
    if (!response.ok) throw Object.assign(new Error(`Log webhook returned HTTP ${response.status}`), { code: 'log_webhook_failed' });
    return { mode: 'sent', target: 'webhook' };
  }
  const token = await googleServiceAccountToken({ serviceAccountJson: log.google.serviceAccountJson, scope: 'https://www.googleapis.com/auth/spreadsheets', fetchImpl });
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(log.google.spreadsheetId)}/values/${encodeURIComponent(log.google.range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ values: [summaryToSheetRow(summary)] }),
  });
  if (!response.ok) throw Object.assign(new Error(`Google Sheets append returned HTTP ${response.status}`), { code: 'log_sheets_failed' });
  return { mode: 'sent', target: 'google_sheets' };
}
