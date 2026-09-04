import { CommandExecutionError } from '@jackwener/opencli/errors';

export const CLARITY_ORIGIN = 'https://clarity.microsoft.com';

/**
 * Microsoft Clarity has no public API for project settings — the official
 * Data Export API and MCP server cover dashboard metrics only. The internal
 * GraphQL endpoint (POST /api/v2) rejects hand-built requests with a flat
 * `400 Bad Request` even for a valid named operation carrying the page's own
 * X-CSRF-Token, so these commands read the rendered Settings surface instead.
 */

const PROJECT_ID_PATTERN = /^[a-z0-9]{6,20}$/i;

export function normalizeProjectId(value, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new TypeError('project-id is required.');
    return undefined;
  }
  const id = String(value).trim();
  if (!PROJECT_ID_PATTERN.test(id)) {
    throw new TypeError(`project-id must be a Clarity project id (alphanumeric), got: ${id}`);
  }
  return id;
}

export function parseProjectIds(value) {
  const explicit = String(value || '').trim();
  if (!explicit) return [];
  const parts = explicit.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) {
    throw new TypeError('project-ids must contain at least one valid project id.');
  }
  return parts.map((id) => normalizeProjectId(id));
}

function ensureObject(value, label) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  throw new CommandExecutionError(`${label} returned an unexpected payload shape from the Browser Bridge.`);
}

export function isRetriableNavigationError(error) {
  const msg = String(error?.message || error);
  return /Navigation rejected|Detached while handling command|Debugger is not attached|Target closed|Session closed/i.test(msg);
}

export async function safeGoto(page, url, options = { waitUntil: 'domcontentloaded' }) {
  try {
    await page.goto(url, options);
    return;
  } catch (error) {
    if (!isRetriableNavigationError(error)) {
      throw error;
    }
  }

  // First fallback: if page context is available, navigate via location.href
  try {
    if (typeof page.evaluate === 'function') {
      await page.evaluate(`location.href = ${JSON.stringify(url)}`);
      return;
    }
  } catch {}

  // Second fallback: wait for in-flight tab navigation to settle, then retry goto
  await new Promise((r) => setTimeout(r, 600));

  try {
    await page.goto(url, options);
    return;
  } catch (error) {
    if (!isRetriableNavigationError(error)) {
      throw error;
    }
  }

  // Third fallback: open a fresh tab explicitly
  if (typeof page.newTab === 'function') {
    try {
      const pageId = await page.newTab(url);
      if (pageId && typeof page.setActivePage === 'function') {
        await page.setActivePage(pageId);
        return;
      }
    } catch {}
  }

  await page.goto(url, options);
}

/**
 * Navigate to a Clarity settings sub-tab and fail loudly when the profile is
 * signed out. The `cb` cache-buster forces a real document load: Clarity is a
 * hash-routed SPA, so navigating to a URL that differs only by `#fragment`
 * changes nothing and would silently return the previous project's page.
 */
export async function gotoClaritySettings(page, projectId, hash, label) {
  if (!page || typeof page.goto !== 'function' || typeof page.evaluate !== 'function') {
    throw new CommandExecutionError(`${label} requires an OpenCLI Browser Bridge page with navigation and visible-DOM access.`);
  }
  const cb = `cb${projectId}`;
  await safeGoto(page, `${CLARITY_ORIGIN}/projects/view/${projectId}/settings?${cb}=1#${hash}`, { waitUntil: 'domcontentloaded' });

  // Wait inside the page, not around it. `page.wait` is not available on every
  // bridge page object, and when it is missing an out-of-page poll spins
  // through every attempt in milliseconds and reads an unpainted document —
  // which surfaces as "0 integration cards" rather than as "too early".
  // Anchor on the block that renders *after* the integration cards. A card
  // title is the wrong anchor twice over: a loose ' integration' matches a
  // half-painted panel (which produced confident WRONG statuses), and a
  // specific card title is not universal — many projects are never offered the
  // Google Tag Manager card at all, so waiting for it always burns the budget.
  const marker = hash === 'setup' ? 'Advanced settings' : '';
  const state = ensureObject(await page.evaluate(`(async () => {
    const marker = ${JSON.stringify(marker)};
    const markerRe = marker ? new RegExp(marker, 'i') : null;
    const deadline = Date.now() + 10000;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let text = '';
    while (Date.now() < deadline) {
      text = document.body ? (document.body.innerText || '') : '';
      if (markerRe ? markerRe.test(text) : text.trim().length > 0) break;
      if (/sign in|log in|welcome to clarity/i.test(document.title + ' ' + text)) break;
      if (/doesn't exist|don't have permissions|access denied|project not found/i.test(text)) break;
      await sleep(500);
    }
    return {
      title: document.title || '',
      href: location.href,
      text: text.replace(/\\s+/g, ' ').trim().slice(0, 600),
      waitedMs: 10000 - Math.max(0, deadline - Date.now()),
      textContentLen: document.body ? String(document.body.textContent || '').length : -1,
    };
  })()`), label);

  if (!state.text) {
    throw new CommandExecutionError(
      `${label}: page at ${state.href} rendered no text after ${state.waitedMs}ms (title="${state.title}", ` +
      `page.wait=${typeof page.wait}, page.goto=${typeof page.goto}, textContentLen=${state.textContentLen}).`,
    );
  }
  if (/sign in|log in|welcome to clarity/i.test(`${state.title} ${state.text}`)) {
    throw new CommandExecutionError(
      'Clarity is not signed in in the selected Browser Bridge profile. Sign in at https://clarity.microsoft.com in that Chrome profile, then retry.',
    );
  }
  if (/doesn't exist|don't have permissions|access denied|project not found/i.test(state.text)) {
    throw new CommandExecutionError(
      `NOT_FOUND: Clarity reported that project ${projectId} does not exist or this account lacks permissions to view it.`,
    );
  }
  // Clarity sends projects that have never received data to an onboarding
  // route. That is a real, actionable state — "not installed yet" — and must
  // not be reported as an unreadable page, nor as "no integrations".
  if (/\/gettingstarted|\/getting-started/i.test(state.href)) {
    throw new CommandExecutionError(
      `NOT_INSTALLED: Clarity redirected project ${projectId} to its Getting Started page (${state.href}) — ` +
      'the tracking code has never sent data, so the Setup tab has no integration cards yet.',
    );
  }
  if (!/\/settings/i.test(state.href)) {
    throw new CommandExecutionError(
      `${label}: expected the settings route for ${projectId} but landed on ${state.href}.`,
    );
  }
  if (!state.href.includes(`/projects/view/${projectId}/`)) {
    throw new CommandExecutionError(
      `Clarity redirected away from project ${projectId} (landed on ${state.href}). The project id may be wrong, or this account may not have access to it.`,
    );
  }
  return state;
}

/**
 * Read the integration cards off the Setup tab.
 *
 * Parsed from the panel's rendered line order rather than the DOM tree: the
 * status pill is always the line directly above "<Name> integration", while
 * the card's own element does not reliably contain its pill — walking up from
 * the title lands on a container holding several cards, which reads as
 * ambiguous and loses the status for exactly the connected ones.
 */
export async function readIntegrationCards(page) {
  const payload = await page.evaluate(`(async () => {
    const PILL = /^(Connected|Not Connected)$/i;
    const TITLE = /^(.+?)\\s+integration$/i;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const valueAfter = (body, label) => {
      // Clarity renders "Account:Foo" inline but "Connected to:" on its own line.
      for (let i = 0; i < body.length; i += 1) {
        const line = body[i];
        if (!line.toLowerCase().startsWith(label.toLowerCase())) continue;
        const inline = line.slice(label.length).trim();
        if (inline) return inline;
        return (body[i + 1] || '').trim();
      }
      return '';
    };

    const parse = () => {
      const lines = String(document.body ? document.body.innerText || '' : '')
        .split('\\n').map((l) => l.trim()).filter((l) => l.length > 0);
      const titleAt = [];
      lines.forEach((line, i) => { const m = line.match(TITLE); if (m) titleAt.push({ i, name: m[1].trim() }); });

      const cards = [];
      for (let t = 0; t < titleAt.length; t += 1) {
        const { i, name } = titleAt[t];
        const prev = lines[i - 1] || '';
        const status = PILL.test(prev) ? prev : 'Unknown';
        const nextTitle = titleAt[t + 1];
        const end = nextTitle ? Math.max(i + 1, nextTitle.i - 1) : lines.length;
        const body = lines.slice(i + 1, end);
        cards.push({
          name,
          status,
          account: valueAfter(body, 'Account:'),
          container: valueAfter(body, 'Container:'),
          connectedTo: valueAfter(body, 'Connected to:'),
        });
      }
      const isComplete = lines.some((l) => /advanced settings/i.test(l))
        || /advanced settings/i.test(document.body ? document.body.innerText || '' : '');
      return { cards, lines, complete: isComplete };
    };

    // Settle on the card count. The cards paint progressively.
    let snap = parse();
    let prev = -1;
    let stable = 0;
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      snap = parse();
      if (snap.cards.length > 0 && (snap.complete || stable >= 1) && snap.cards.length === prev) {
        stable += 1;
        if (stable >= 2) break;
      } else {
        stable = 0;
      }
      prev = snap.cards.length;
      await sleep(800);
    }

    return {
      cards: snap.cards,
      complete: snap.complete,
      settled: stable >= 2,
      href: location.href,
      lineCount: snap.lines.length,
      sample: snap.lines.slice(0, 26).join(' | ').slice(0, 400),
    };
  })()`);

  const obj = ensureObject(payload, 'Clarity integrations');
  if (!Array.isArray(obj.cards)) {
    throw new CommandExecutionError('Clarity integrations returned no card array from the Browser Bridge.');
  }
  // Refuse anything that did not settle. A partial panel does not degrade to
  // "unknown" on its own — it silently turns present integrations into absent
  // ones, which is a confident wrong answer.
  if (obj.cards.length === 0 || !obj.complete || !obj.settled) {
    throw new CommandExecutionError(
      `Clarity Setup panel did not settle at ${obj.href} — ` +
      `${obj.cards.length} card(s), ${obj.lineCount} lines, end-marker ${obj.complete ? 'present' : 'absent'}, ` +
      `settled=${obj.settled}. First lines: ${obj.sample}`,
    );
  }
  return obj.cards;
}

/**
 * Enumerate every project on the account from the /projects grid.
 *
 * Each project card on the Clarity grid carries `data-clarity-id="projectClicked_<id>"`,
 * binding the exact project ID, friendly name, and site URL deterministically.
 */
export async function discoverProjects(page) {
  await safeGoto(page, `${CLARITY_ORIGIN}/projects`, { waitUntil: 'domcontentloaded' });

  let last = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let payload;
    try {
      payload = await page.evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const deadline = Date.now() + 15000;

      // If SPA redirected to a specific project dashboard, switch back to the projects grid
      if (location.href.includes('/projects/view/')) {
        const myProj = [...document.querySelectorAll('a, button, div, span')]
          .find((el) => (el.innerText || '').trim() === 'My Projects');
        if (myProj) myProj.click();
        else {
          const logo = document.querySelector('a[class*="header_clarityLogo"]');
          if (logo) logo.click();
        }
      }

      // Settle on the project cards. Each card carries data-clarity-id="projectClicked_<projectId>"
      let prevCount = -1;
      let stableRounds = 0;
      while (Date.now() < deadline) {
        const cards = [...document.querySelectorAll('[data-clarity-id^="projectClicked_"]')];
        if (cards.length > 0) {
          if (cards.length === prevCount) {
            stableRounds += 1;
            if (stableRounds >= 2) {
              const projects = cards.map((c) => {
                const id = c.dataset.clarityId.replace('projectClicked_', '');
                const lines = (c.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean);
                return {
                  ProjectId: id,
                  Name: lines[0] || '',
                  Site: lines[1] || '',
                };
              });
              return { settled: true, projects, count: projects.length };
            }
          } else {
            stableRounds = 0;
          }
          prevCount = cards.length;
        } else if (location.href.includes('/projects/view/')) {
          const myProj = [...document.querySelectorAll('a, button, div, span')]
            .find((el) => (el.innerText || '').trim() === 'My Projects');
          if (myProj) myProj.click();
        }
        await sleep(750);
      }

      // Check for signed-out state only if polling deadline expired without cards
      const bodyText = document.body ? document.body.innerText : '';
      if (/sign in|log in|welcome to clarity/i.test(document.title + ' ' + bodyText)) {
        return { notSignedIn: true, projects: [] };
      }

      // Fallback: if data-clarity-id is absent in future markup, use bounded fiber scan
      const html = document.documentElement.outerHTML;
      const ids = new Set();
      for (const m of html.matchAll(/projects\\/view\\/([a-z0-9]{6,20})/gi)) ids.add(m[1]);
      const SITE = /^(?:https?:\\/\\/)?(?:www\\.)?[a-z0-9-]+(?:\\.[a-z0-9-]+)+(?:\\/\\S*)?$/i;
      const lines = String(document.body ? document.body.innerText || '' : '')
        .split('\\n').map((l) => l.trim()).filter(Boolean);
      const pairs = [];
      for (let i = 0; i < lines.length - 1; i += 1) {
        if (SITE.test(lines[i + 1]) && !SITE.test(lines[i])) pairs.push({ name: lines[i], site: lines[i + 1] });
      }

      return {
        settled: false,
        projects: [...ids].map((id, index) => ({
          ProjectId: id,
          Name: pairs[index] ? pairs[index].name : '',
          Site: pairs[index] ? pairs[index].site : '',
        })),
        count: ids.size,
        href: location.href,
        title: document.title || '',
        lines: lines.slice(0, 100),
      };
    })()`);
    } catch (err) {
      if (err instanceof CommandExecutionError && err.message.includes('not signed in')) {
        throw err;
      }
      if (isRetriableNavigationError(err) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 1000));
        await safeGoto(page, `${CLARITY_ORIGIN}/projects`, { waitUntil: 'domcontentloaded' });
        continue;
      }
      throw err;
    }
    last = payload;

    if (payload?.notSignedIn) {
      throw new CommandExecutionError(
        'Clarity is not signed in in the selected Browser Bridge profile. Sign in at https://clarity.microsoft.com in that Chrome profile, then retry.',
      );
    }

    if (payload && Array.isArray(payload.projects) && payload.projects.length > 0) {
      return payload.projects;
    }
  }

  throw new CommandExecutionError(
    'Could not read any project id from the Clarity projects grid. ' +
    `Landed on ${last && last.href} (title="${last && last.title}"). ` +
    'Pass ids explicitly instead: opencli clarity audit --project-ids <a,b,c>',
  );
}

/**
 * Absent is not "not connected". A card the page never rendered is `Unknown`,
 * which must stay distinguishable from a card that rendered "Not Connected" —
 * a layout change that drops a card would otherwise read as a real finding and
 * send the user to reconnect something that was fine.
 */
export function detailFor(card) {
  if (card.account || card.container) {
    return [card.account && `account=${card.account}`, card.container && `container=${card.container}`]
      .filter(Boolean).join(' ');
  }
  if (card.connectedTo) return `url=${card.connectedTo}`;
  return '';
}
