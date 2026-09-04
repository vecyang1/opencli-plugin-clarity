import { cli, Strategy } from '@jackwener/opencli/registry';
import { discoverProjects, gotoClaritySettings, parseProjectIds, readIntegrationCards } from './_ui.js';

const DEFAULT_REQUIRED = 'Google Analytics,Google Tag Manager';

export function statusOf(cards, name) {
  const hit = cards.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (hit) return hit.status;
  // The panel finished painting and this card was not on it — Clarity does not
  // offer that integration for this project. That is a third state: it is not
  // "Not Connected" (nothing to connect) and not "Unknown" (we did read it).
  return 'Not offered';
}

export function computeAuditVerdict({ cards, readError = '', required = [] }) {
  if (readError.startsWith('NOT_INSTALLED:')) {
    return 'not installed: Clarity has never received data from this site';
  }
  if (readError.startsWith('NOT_FOUND:')) {
    return 'not found: project does not exist or no permission';
  }
  if (readError) {
    return `unknown: ${readError}`;
  }

  const ga  = cards ? statusOf(cards, 'Google Analytics')    : 'Unknown';
  const gtm = cards ? statusOf(cards, 'Google Tag Manager')  : 'Unknown';
  const gad = cards ? statusOf(cards, 'Google Ads')          : 'Unknown';
  const mad = cards ? statusOf(cards, 'Microsoft Ads')       : 'Unknown';

  const byName = {
    'google analytics': ga,
    'google tag manager': gtm,
    'google ads': gad,
    'microsoft ads': mad,
  };

  const missing = [];
  const notOffered = [];
  const unknown = [];

  for (const req of required) {
    const status = byName[req.toLowerCase()] || 'Unknown';
    if (/^not connected$/i.test(status)) missing.push(req);
    else if (/^not offered$/i.test(status)) notOffered.push(req);
    else if (!status || /^unknown$/i.test(status)) unknown.push(req);
  }

  if (missing.length) return `setup needed: ${missing.join(' + ')}`;
  if (unknown.length) return `unknown: ${unknown.join(' + ')} not readable`;
  if (notOffered.length) return `ok (${notOffered.join(' + ')} not offered for this project)`;
  return 'ok';
}

export function relabelSignedOutRows(rows) {
  const anySucceeded = rows.some((r) =>
    r.Verdict.startsWith('ok') ||
    r.Verdict.startsWith('setup') ||
    r.Verdict.startsWith('not found')
  );
  if (!anySucceeded) return rows;

  for (const row of rows) {
    if (/not signed in/i.test(row.Verdict)) {
      row.Verdict = 'no access: Clarity served its signed-out shell for this project while other projects in the same run read fine — the account likely cannot open it';
    }
  }
  return rows;
}

export const auditCommand = cli({
  site: 'clarity',
  name: 'audit',
  access: 'read',
  description: 'Check Google Analytics / Google Tag Manager (and Ads) integration status across every Clarity project, and flag the ones that still need setting up. Read-only.',
  example: 'opencli clarity audit -f table',
  domain: 'clarity.microsoft.com',
  strategy: Strategy.UI,
  browser: true,
  siteSession: 'ephemeral',
  navigateBefore: false,
  args: [
    { name: 'project-ids', type: 'string', required: false, help: 'Comma-separated project ids to check. Omit to auto-discover every project on the account.' },
    { name: 'required', type: 'string', required: false, default: DEFAULT_REQUIRED, help: `Comma-separated integrations that must be Connected. Default: ${DEFAULT_REQUIRED}` },
    { name: 'only-issues', type: 'boolean', required: false, default: false, help: 'Return only projects whose verdict is not ok.' },
  ],
  columns: ['ProjectId', 'Name', 'GoogleAnalytics', 'GoogleTagManager', 'GoogleAds', 'MicrosoftAds', 'Verdict'],
  func: async (page, kwargs) => {
    const required = String(kwargs.required || DEFAULT_REQUIRED)
      .split(',').map((s) => s.trim()).filter(Boolean);

    const explicitIds = parseProjectIds(kwargs['project-ids']);
    let targets;
    if (explicitIds.length) {
      targets = explicitIds.map((id) => ({ ProjectId: id, Name: '' }));
    } else {
      targets = await discoverProjects(page);
    }

    const rows = [];
    for (const target of targets) {
      const projectId = target.ProjectId;
      let cards = null;
      let readError = '';
      // Retry once: a partial render is transient, and the card guard turns it
      // into a refusal rather than a wrong status — so a second look is cheap
      // and converts most would-be `unknown` rows into real readings.
      for (let attempt = 0; attempt < 2 && !cards; attempt += 1) {
        try {
          await gotoClaritySettings(page, projectId, 'setup', 'Clarity audit');
          cards = await readIntegrationCards(page);
          readError = '';
        } catch (error) {
          readError = String(error && error.message ? error.message : error).slice(0, 300);
          if (
            readError.startsWith('NOT_INSTALLED:') ||
            readError.startsWith('NOT_FOUND:') ||
            /not signed in/i.test(readError)
          ) {
            break;
          }
        }
      }

      const ga  = cards ? statusOf(cards, 'Google Analytics')    : 'Unknown';
      const gtm = cards ? statusOf(cards, 'Google Tag Manager')  : 'Unknown';
      const gad = cards ? statusOf(cards, 'Google Ads')          : 'Unknown';
      const mad = cards ? statusOf(cards, 'Microsoft Ads')       : 'Unknown';

      const verdict = computeAuditVerdict({ cards, readError, required });

      rows.push({
        ProjectId: projectId,
        Name: target.Name || '',
        GoogleAnalytics: ga,
        GoogleTagManager: gtm,
        GoogleAds: gad,
        MicrosoftAds: mad,
        Verdict: verdict,
      });
    }

    relabelSignedOutRows(rows);

    return kwargs['only-issues'] === true ? rows.filter((r) => !r.Verdict.startsWith('ok')) : rows;
  },
});
