/**
 * Configuration shared by the Node.js CLI and the n8n workflow.
 *
 * Fail-safe rules:
 * - DRY_RUN and SANDBOX_MODE stay true unless explicitly set to false/0/no/off.
 * - Values like "YOUR_..._HERE" / "your_..._here" count as "not configured".
 * - SMTP_CHECKER_PROVIDER defaults to "mock": no email address leaves the machine.
 * - MARKETING_STATUS_WRITE_MODE defaults to "quarantine_only": the workflow writes a
 *   quarantine status and leaves the Marketing Contact flip to a HubSpot workflow.
 *
 * Embedded verbatim into the n8n Code nodes by scripts/build-workflow.js:
 * top-level names must be unique across src/core/.
 */

const HYGIENE_PLACEHOLDER_RE = /^(?:|your_[a-z0-9_]*_here|changeme|change_me|placeholder|x{3,})$/i;

export const HYGIENE_STATUSES = [
  'verified',
  'flagged_title_mismatch',
  'flagged_missing_title',
  'flagged_role_address',
  'flagged_unverified',
  'quarantine_bounced',
  'quarantine_invalid',
  'quarantine_disposable',
  'quarantine_risky',
  'quarantine_unverified',
  'quarantine_title_mismatch',
  'exempt',
];

export function isUnsetValue(value) {
  if (value === undefined || value === null) return true;
  return HYGIENE_PLACEHOLDER_RE.test(String(value).trim());
}

export function envFlag(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  const v = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return defaultValue;
}

function envInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envNumber(value, fallback) {
  const n = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envList(value, fallback = []) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return String(value).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function envChoice(value, allowed, fallback) {
  const v = String(value ?? '').trim().toLowerCase();
  return allowed.includes(v) ? v : fallback;
}

export function loadHygieneConfig(env = {}) {
  const read = (key, fallback = '') => {
    const value = env[key];
    return value === undefined || value === null ? fallback : String(value).trim();
  };
  const provider = read('SMTP_CHECKER_PROVIDER', 'mock').toLowerCase();
  return {
    dryRun: envFlag(env.DRY_RUN, true),
    sandboxMode: envFlag(env.SANDBOX_MODE, true),
    audit: {
      intervalDays: envInt(env.AUDIT_INTERVAL_DAYS, 90),
      staleAfterDays: envInt(env.STALE_AFTER_DAYS, 180),
      recheckAfterDays: envInt(env.RECHECK_AFTER_DAYS, 90),
      maxContacts: envInt(env.MAX_CONTACTS_PER_RUN, 2000),
      onlyMarketingContacts: envFlag(env.ONLY_MARKETING_CONTACTS, true),
    },
    checker: {
      provider: ['mock', 'zerobounce', 'neverbounce', 'custom'].includes(provider) ? provider : 'invalid',
      apiKey: read('SMTP_CHECKER_API_KEY'),
      url: read('SMTP_CHECKER_URL'),
      delayMs: envInt(env.SMTP_CHECK_DELAY_MS, 250),
      maxVerifications: envInt(env.MAX_VERIFICATIONS_PER_RUN, 500),
      timeoutMs: envInt(env.SMTP_CHECK_TIMEOUT_MS, 10000),
    },
    titles: {
      targetKeywords: envList(env.TARGET_TITLE_KEYWORDS, [
        'chief', 'ceo', 'cfo', 'cro', 'cmo', 'coo', 'cto', 'founder', 'owner', 'president', 'vp', 'vice president',
        'head of', 'director', 'manager', 'revops', 'revenue operations', 'marketing operations', 'sales operations',
      ]),
      excludedKeywords: envList(env.EXCLUDED_TITLE_KEYWORDS, ['student', 'intern', 'retired', 'former', 'unemployed', 'seeking', 'test']),
      mismatchAction: envChoice(env.TITLE_MISMATCH_ACTION, ['flag', 'quarantine'], 'flag'),
      missingAction: envChoice(env.MISSING_TITLE_ACTION, ['flag', 'ignore'], 'flag'),
    },
    policy: {
      unverifiedAction: envChoice(env.UNVERIFIED_ACTION, ['quarantine', 'flag'], 'quarantine'),
      roleAddressAction: envChoice(env.ROLE_ADDRESS_ACTION, ['flag', 'quarantine'], 'flag'),
      nonMarketingStatuses: envList(env.NON_MARKETING_STATUSES, ['quarantine_bounced', 'quarantine_invalid', 'quarantine_disposable', 'quarantine_risky']),
      marketingStatusWriteMode: envChoice(env.MARKETING_STATUS_WRITE_MODE, ['quarantine_only', 'property'], 'quarantine_only'),
      exemptLifecycleStages: envList(env.EXEMPT_LIFECYCLE_STAGES, ['customer', 'evangelist', 'opportunity']),
      maxQuarantineRatio: envNumber(env.MAX_QUARANTINE_RATIO, 0.3),
      circuitBreakerMinSample: envInt(env.CIRCUIT_BREAKER_MIN_SAMPLE, 20),
      maxUpdates: envInt(env.MAX_UPDATES_PER_RUN, 1000),
    },
    savings: {
      monthlyCostPer1000: envNumber(env.MARKETING_CONTACT_MONTHLY_COST_PER_1000, 0),
      currency: read('COST_CURRENCY', 'USD').toUpperCase(),
    },
    hubspot: {
      token: read('HUBSPOT_PRIVATE_APP_TOKEN'),
      sandboxPortalId: read('HUBSPOT_SANDBOX_PORTAL_ID'),
      baseUrl: read('HUBSPOT_BASE_URL', 'https://api.hubapi.com'),
      searchDelayMs: envInt(env.HUBSPOT_SEARCH_DELAY_MS, 300),
    },
    log: {
      target: envChoice(env.LOG_TARGET, ['none', 'webhook', 'google_sheets'], 'none'),
      webhookUrl: read('LOG_WEBHOOK_URL'),
      webhookSecret: read('LOG_WEBHOOK_SECRET'),
      includeContactIds: envFlag(env.LOG_INCLUDE_CONTACT_IDS, false),
      google: {
        serviceAccountJson: read('GOOGLE_SERVICE_ACCOUNT_JSON'),
        spreadsheetId: read('GOOGLE_SHEETS_SPREADSHEET_ID'),
        range: read('GOOGLE_SHEETS_RANGE', 'Hygiene Log!A1'),
      },
    },
  };
}

export function validateHygieneConfig(config) {
  const errors = [];
  const warnings = [];
  const live = !config.dryRun;
  if (config.checker.provider === 'invalid') errors.push('SMTP_CHECKER_PROVIDER must be mock, zerobounce, neverbounce or custom');
  if (['zerobounce', 'neverbounce', 'custom'].includes(config.checker.provider) && isUnsetValue(config.checker.apiKey)) {
    errors.push(`SMTP_CHECKER_API_KEY is required for SMTP_CHECKER_PROVIDER=${config.checker.provider}`);
  }
  if (config.checker.provider === 'custom' && !/^https:\/\//.test(config.checker.url)) errors.push('SMTP_CHECKER_URL must be an https:// URL for the custom provider');
  if (config.audit.staleAfterDays < 30) errors.push('STALE_AFTER_DAYS must be at least 30');
  if (config.audit.intervalDays < 1) errors.push('AUDIT_INTERVAL_DAYS must be at least 1');
  if (config.policy.maxQuarantineRatio <= 0 || config.policy.maxQuarantineRatio > 1) errors.push('MAX_QUARANTINE_RATIO must be greater than 0 and at most 1');
  for (const s of config.policy.nonMarketingStatuses) if (!HYGIENE_STATUSES.includes(s)) errors.push(`NON_MARKETING_STATUSES has unknown status "${s}"`);
  if (config.log.target === 'webhook' && !/^https:\/\//.test(config.log.webhookUrl)) errors.push('LOG_WEBHOOK_URL must be an https:// URL when LOG_TARGET=webhook');
  if (config.log.target === 'google_sheets') {
    if (isUnsetValue(config.log.google.serviceAccountJson)) errors.push('GOOGLE_SERVICE_ACCOUNT_JSON is required when LOG_TARGET=google_sheets');
    if (isUnsetValue(config.log.google.spreadsheetId)) errors.push('GOOGLE_SHEETS_SPREADSHEET_ID is required when LOG_TARGET=google_sheets');
  }
  if (config.savings.monthlyCostPer1000 === 0) warnings.push('MARKETING_CONTACT_MONTHLY_COST_PER_1000 is 0: savings are reported as 0');
  if (config.log.target === 'none') warnings.push('LOG_TARGET=none: the summary is only returned, not appended anywhere');
  if (live) {
    if (isUnsetValue(config.hubspot.token)) errors.push('HUBSPOT_PRIVATE_APP_TOKEN is missing or a placeholder');
    if (config.checker.provider === 'mock') errors.push('SMTP_CHECKER_PROVIDER=mock cannot drive live HubSpot updates; set DRY_RUN=true or choose a real provider');
    if (!config.sandboxMode) warnings.push('SANDBOX_MODE=false and DRY_RUN=false: production HubSpot contacts are updated');
  }
  return { errors, warnings };
}
