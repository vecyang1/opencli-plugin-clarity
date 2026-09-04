import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { CLARITY_ORIGIN, discoverProjects, parseProjectIds, safeGoto } from './_ui.js';

const DEFAULT_RANGE = 'Last 30 days';

/**
 * Read the Overview dashboard for one project.
 *
 * The requested date range is echoed back by the page and asserted here. A
 * range parameter that is accepted and quietly ignored would report last-3-days
 * numbers under a "Last 30 days" label — a result labelled with a window it
 * does not describe is worse than no result, because nobody re-runs it.
 */
async function readDashboard(page, projectId, range) {
  const url = `${CLARITY_ORIGIN}/projects/view/${projectId}/dashboard`
    + `?date=${encodeURIComponent(range)}&cb${projectId}=1`;
  await safeGoto(page, url, { waitUntil: 'domcontentloaded' });

  const out = await page.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const read = () => String(document.body ? document.body.innerText || '' : '')
      .split('\\n').map((l) => l.trim()).filter(Boolean);

    // Settle on the line count. The dashboard paints its tiles progressively
    // and an early read returns the skeleton, whose metric tiles are absent —
    // which the parser would report as a confident zero.
    let lines = [], prev = -1, stable = 0;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      lines = read();
      if (/sign in|welcome to clarity/i.test(document.title)) break;
      if (/gettingstarted|getting-started/i.test(location.href)) break;
      if (/doesn't exist|don't have permissions|access denied|project not found/i.test(lines.join(' '))) break;
      if (lines.length > 20 && lines.includes('Sessions') && lines.length === prev) {
        stable += 1;
        if (stable >= 2) break;
      } else {
        stable = 0;
      }
      prev = lines.length;
      await sleep(800);
    }

    const idx = (label) => lines.findIndex((l) => l === label);
    const after  = (label) => { const i = idx(label); return i >= 0 ? (lines[i + 1] || '') : ''; };
    const before = (label) => { const i = idx(label); return i > 0  ? (lines[i - 1] || '') : ''; };

    // Clarity labels the applied window on its own line next to "Segments".
    const si = idx('Segments');
    const appliedRange = si >= 0 ? (lines[si + 1] || '') : '';

    return {
      href: location.href,
      title: document.title || '',
      settled: stable >= 2,
      lineCount: lines.length,
      appliedRange,
      sessions: after('Sessions'),
      pagesPerSession: after('Pages per session'),
      scrollDepth: after('Scroll depth'),
      activeTime: after('Active time spent'),
      uniqueUsers: before('Unique users'),
      liveUsers: before('Live users'),
      rageClicks: (() => { const i = idx('Rage clicks'); return i >= 0 ? (lines[i + 2] || '') : ''; })(),
      deadClicks: (() => { const i = idx('Dead clicks'); return i >= 0 ? (lines[i + 2] || '') : ''; })(),
      thin: lines.some((l) => /not enough traffic data/i.test(l)),
      sample: lines.slice(0, 24).join(' | ').slice(0, 400),
    };
  })()`);

  if (!out || typeof out !== 'object') {
    throw new CommandExecutionError('Clarity traffic returned an unexpected payload from the Browser Bridge.');
  }
  if (/gettingstarted|getting-started/i.test(out.href)) {
    throw new CommandExecutionError(
      `NOT_INSTALLED: Clarity redirected project ${projectId} to Getting Started (${out.href}) — `
      + 'the tag has never sent data, so Clarity holds no traffic for it either way.',
    );
  }
  if (/sign in|welcome to clarity/i.test(out.title)) {
    throw new CommandExecutionError(
      'Clarity is not signed in in the selected Browser Bridge profile. '
      + 'Sign in at https://clarity.microsoft.com in that Chrome profile, then retry.',
    );
  }
  if (/doesn't exist|don't have permissions|access denied|project not found/i.test(out.sample + ' ' + (out.title || ''))) {
    throw new CommandExecutionError(
      `NOT_FOUND: Clarity reported that project ${projectId} does not exist or this account lacks permissions to view it.`,
    );
  }
  if (!out.settled || !out.sessions) {
    throw new CommandExecutionError(
      `Clarity dashboard did not settle for ${projectId} at ${out.href} — `
      + `${out.lineCount} lines, settled=${out.settled}, sessions="${out.sessions}". First lines: ${out.sample}`,
    );
  }
  // Read back the window the page actually applied. See the note above.
  if (out.appliedRange.trim().toLowerCase() !== range.trim().toLowerCase()) {
    throw new CommandExecutionError(
      `Clarity ignored the requested date range for ${projectId}: asked "${range}", `
      + `page reports "${out.appliedRange}". Refusing to label these numbers with a window they do not describe.`,
    );
  }
  return out;
}

// "1,234" -> 1234. Anything that is not a plain count (an abbreviation, a dash,
// an empty tile) returns null so it stays distinguishable from a measured zero.
export function toCount(raw) {
  const s = String(raw || '').trim().replace(/,/g, '');
  if (!/^\d+$/.test(s)) return null;
  return Number(s);
}

export function computeTrafficVerdict({ data, readError = '', range = DEFAULT_RANGE }) {
  if (readError.startsWith('NOT_INSTALLED:')) {
    // Clarity holding nothing is a fact about Clarity, not about the site.
    return 'not measured: Clarity tag never fired — this says nothing about whether the site has visitors';
  }
  if (readError.startsWith('NOT_FOUND:')) {
    return 'not found: project does not exist or no permission';
  }
  if (readError.includes('ignored the requested date range')) {
    return `unknown: unrecognised date range "${range}"`;
  }
  if (readError) {
    return `unknown: ${readError}`;
  }

  const sessions = data ? toCount(data.sessions) : null;
  if (sessions === null) {
    return `unknown: sessions tile read as "${data?.sessions}", not a plain count`;
  }
  if (sessions === 0) {
    return `no traffic: 0 sessions in ${range}`;
  }
  return `active: ${sessions} sessions`;
}

export const trafficCommand = cli({
  site: 'clarity',
  name: 'traffic',
  access: 'read',
  description: 'Read recent traffic (sessions, users, rage/dead clicks) from each Clarity project dashboard, to tell projects with real visitors from dormant ones. Read-only.',
  example: 'opencli clarity traffic --range "Last 30 days" -f table',
  domain: 'clarity.microsoft.com',
  strategy: Strategy.UI,
  browser: true,
  siteSession: 'ephemeral',
  navigateBefore: false,
  args: [
    { name: 'project-ids', type: 'string', required: false, help: 'Comma-separated project ids. Omit to auto-discover every project on the account.' },
    { name: 'range', type: 'string', required: false, default: DEFAULT_RANGE, help: `Clarity date-range label, exactly as the picker spells it. Default: ${DEFAULT_RANGE}` },
  ],
  columns: ['ProjectId', 'Name', 'Range', 'Sessions', 'Users', 'PagesPerSession', 'RageClickSessions', 'DeadClickSessions', 'Verdict'],
  func: async (page, kwargs) => {
    const range = String(kwargs.range || DEFAULT_RANGE).trim();

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
      let data = null;
      let readError = '';
      for (let attempt = 0; attempt < 2 && !data; attempt += 1) {
        try {
          data = await readDashboard(page, projectId, range);
          readError = '';
        } catch (error) {
          readError = String(error && error.message ? error.message : error).slice(0, 300);
          if (
            readError.startsWith('NOT_INSTALLED:') ||
            readError.startsWith('NOT_FOUND:') ||
            readError.includes('ignored the requested date range') ||
            /not signed in/i.test(readError)
          ) {
            break;
          }
        }
      }

      const verdict = computeTrafficVerdict({ data, readError, range });

      rows.push({
        ProjectId: projectId,
        Name: target.Name || '',
        Range: data ? data.appliedRange : '',
        Sessions: data ? (data.sessions || 'Unknown') : 'Unknown',
        Users: data ? (data.uniqueUsers || 'Unknown') : 'Unknown',
        PagesPerSession: data ? (data.pagesPerSession || 'Unknown') : 'Unknown',
        RageClickSessions: data ? (data.rageClicks || 'Unknown') : 'Unknown',
        DeadClickSessions: data ? (data.deadClicks || 'Unknown') : 'Unknown',
        Verdict: verdict,
      });
    }
    return rows;
  },
});
