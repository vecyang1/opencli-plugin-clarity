import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import { computeAuditVerdict, relabelSignedOutRows, statusOf } from './audit.js';
import { detailFor, isRetriableNavigationError, normalizeProjectId, parseProjectIds, safeGoto } from './_ui.js';
import { computeTrafficVerdict, toCount } from './traffic.js';
import './audit.js';
import './integrations.js';
import './projects.js';
import './traffic.js';

describe('clarity adapter registration', () => {
  it('registers all four read-only commands against the Clarity host', () => {
    for (const name of ['audit', 'integrations', 'projects', 'traffic']) {
      const command = getRegistry().get(`clarity/${name}`);
      expect(command, `clarity/${name} should be registered`).toBeDefined();
      expect(command?.access).toBe('read');
      expect(command?.domain).toBe('clarity.microsoft.com');
      expect(command?.browser).toBe(true);
      expect(command?.siteSession).toBe('ephemeral');
    }
  });

  it('declares audit columns matching the keys its func returns', () => {
    expect(getRegistry().get('clarity/audit')?.columns).toEqual([
      'ProjectId', 'Name', 'GoogleAnalytics', 'GoogleTagManager',
      'GoogleAds', 'MicrosoftAds', 'Verdict',
    ]);
  });

  it('declares integrations columns matching the keys its func returns', () => {
    expect(getRegistry().get('clarity/integrations')?.columns).toEqual([
      'Project', 'Integration', 'Status', 'Detail',
    ]);
  });

  it('declares projects columns matching the keys its func returns', () => {
    expect(getRegistry().get('clarity/projects')?.columns).toEqual([
      'ProjectId', 'Name', 'Site',
    ]);
  });

  it('declares traffic columns matching the keys its func returns', () => {
    expect(getRegistry().get('clarity/traffic')?.columns).toEqual([
      'ProjectId', 'Name', 'Range', 'Sessions', 'Users',
      'PagesPerSession', 'RageClickSessions', 'DeadClickSessions', 'Verdict',
    ]);
  });
});

describe('statusOf keeps the four states distinct', () => {
  const cards = [
    { name: 'Google Analytics', status: 'Connected' },
    { name: 'Google Ads', status: 'Not Connected' },
  ];

  it('reports the status a rendered card carried', () => {
    expect(statusOf(cards, 'Google Analytics')).toBe('Connected');
    expect(statusOf(cards, 'Google Ads')).toBe('Not Connected');
  });

  it('matches a card name case-insensitively', () => {
    expect(statusOf(cards, 'google analytics')).toBe('Connected');
  });

  // The whole point of the third state. A card Clarity never offers for a
  // project must not read as one the user declined to connect — collapsing
  // them sends someone to reconnect an integration that does not exist.
  it('reports an absent card as Not offered, never as Not Connected', () => {
    const absent = statusOf(cards, 'Google Tag Manager');
    expect(absent).toBe('Not offered');
    expect(absent).not.toBe('Not Connected');
  });
});

describe('normalizeProjectId refuses anything that is not an id', () => {
  it('accepts a Clarity project id', () => {
    expect(normalizeProjectId('a1b2c3d4e5')).toBe('a1b2c3d4e5');
    expect(normalizeProjectId('  a1b2c3d4e5  ')).toBe('a1b2c3d4e5');
  });

  // A bad id would otherwise be pasted into a URL and navigated to, and
  // Clarity answers an unknown project with a redirect that reads like a
  // signed-out page.
  it('rejects punctuation, paths and empties rather than navigating to them', () => {
    for (const bad of ['', '   ', 'not/an/id', 'abc', 'a1b2c3d4e5!', '../../etc']) {
      expect(() => normalizeProjectId(bad), `should reject ${JSON.stringify(bad)}`).toThrow();
    }
  });

  it('returns undefined for an optional id that was not supplied', () => {
    expect(normalizeProjectId('', { required: false })).toBeUndefined();
    expect(normalizeProjectId(undefined, { required: false })).toBeUndefined();
  });
});

describe('parseProjectIds handles user inputs defensively', () => {
  it('parses comma-separated project ids and trims spaces', () => {
    expect(parseProjectIds('sv4r4n50lc, vjvwataqcy')).toEqual(['sv4r4n50lc', 'vjvwataqcy']);
    expect(parseProjectIds('  sv4r4n50lc  ,   vjvwataqcy  ')).toEqual(['sv4r4n50lc', 'vjvwataqcy']);
  });

  it('strips empty items from trailing or consecutive commas', () => {
    expect(parseProjectIds('sv4r4n50lc, vjvwataqcy, ')).toEqual(['sv4r4n50lc', 'vjvwataqcy']);
    expect(parseProjectIds(', sv4r4n50lc ,, vjvwataqcy ,')).toEqual(['sv4r4n50lc', 'vjvwataqcy']);
  });

  it('returns empty array when input is empty, null, or undefined', () => {
    expect(parseProjectIds('')).toEqual([]);
    expect(parseProjectIds(null)).toEqual([]);
    expect(parseProjectIds(undefined)).toEqual([]);
  });

  it('throws when string contains only commas and spaces', () => {
    expect(() => parseProjectIds(' , , ')).toThrow('project-ids must contain at least one valid project id.');
  });

  it('throws if any item in the list is not a valid project id', () => {
    expect(() => parseProjectIds('sv4r4n50lc, bad!id')).toThrow('project-id must be a Clarity project id');
  });
});

describe('computeAuditVerdict covers all verdict logic', () => {
  const connectedCards = [
    { name: 'Google Analytics', status: 'Connected' },
    { name: 'Google Tag Manager', status: 'Connected' },
    { name: 'Google Ads', status: 'Connected' },
    { name: 'Microsoft Ads', status: 'Connected' },
  ];

  it('returns ok when all required integrations are connected', () => {
    expect(computeAuditVerdict({
      cards: connectedCards,
      required: ['Google Analytics', 'Google Tag Manager'],
    })).toBe('ok');
  });

  it('returns setup needed when an integration is Not Connected', () => {
    const cards = [
      { name: 'Google Analytics', status: 'Connected' },
      { name: 'Google Tag Manager', status: 'Not Connected' },
    ];
    expect(computeAuditVerdict({
      cards,
      required: ['Google Analytics', 'Google Tag Manager'],
    })).toBe('setup needed: Google Tag Manager');
  });

  it('joins multiple missing integrations with +', () => {
    const cards = [
      { name: 'Google Analytics', status: 'Not Connected' },
      { name: 'Google Tag Manager', status: 'Not Connected' },
    ];
    expect(computeAuditVerdict({
      cards,
      required: ['Google Analytics', 'Google Tag Manager'],
    })).toBe('setup needed: Google Analytics + Google Tag Manager');
  });

  it('marks not offered integration as ok (not offered for this project)', () => {
    const cards = [
      { name: 'Google Analytics', status: 'Connected' },
      // GTM not offered
    ];
    expect(computeAuditVerdict({
      cards,
      required: ['Google Analytics', 'Google Tag Manager'],
    })).toBe('ok (Google Tag Manager not offered for this project)');
  });

  it('marks unknown card as not readable', () => {
    const cards = [
      { name: 'Google Analytics', status: 'Connected' },
      { name: 'Google Tag Manager', status: 'Unknown' },
    ];
    expect(computeAuditVerdict({
      cards,
      required: ['Google Analytics', 'Google Tag Manager'],
    })).toBe('unknown: Google Tag Manager not readable');
  });

  it('reports NOT_INSTALLED error accurately', () => {
    expect(computeAuditVerdict({
      cards: null,
      readError: 'NOT_INSTALLED: Clarity redirected project to Getting Started',
      required: ['Google Analytics'],
    })).toBe('not installed: Clarity has never received data from this site');
  });

  it('reports NOT_FOUND error accurately', () => {
    expect(computeAuditVerdict({
      cards: null,
      readError: 'NOT_FOUND: Clarity reported project does not exist',
      required: ['Google Analytics'],
    })).toBe('not found: project does not exist or no permission');
  });

  it('reports generic read error as unknown', () => {
    expect(computeAuditVerdict({
      cards: null,
      readError: 'Page crashed',
      required: ['Google Analytics'],
    })).toBe('unknown: Page crashed');
  });
});

describe('relabelSignedOutRows differentiates global signed-out from single project no-access', () => {
  it('relabels not signed in row as no access when another project succeeded', () => {
    const rows = [
      { ProjectId: 'p1', Verdict: 'ok' },
      { ProjectId: 'p2', Verdict: 'unknown: Clarity is not signed in' },
    ];
    relabelSignedOutRows(rows);
    expect(rows[0].Verdict).toBe('ok');
    expect(rows[1].Verdict).toContain('no access: Clarity served its signed-out shell');
  });

  it('does NOT relabel when all projects failed with not signed in', () => {
    const rows = [
      { ProjectId: 'p1', Verdict: 'unknown: Clarity is not signed in' },
      { ProjectId: 'p2', Verdict: 'unknown: Clarity is not signed in' },
    ];
    relabelSignedOutRows(rows);
    expect(rows[0].Verdict).toBe('unknown: Clarity is not signed in');
    expect(rows[1].Verdict).toBe('unknown: Clarity is not signed in');
  });
});

describe('computeTrafficVerdict covers all traffic verdicts', () => {
  it('reports active traffic when sessions > 0', () => {
    expect(computeTrafficVerdict({
      data: { sessions: '39' },
      range: 'Last 30 days',
    })).toBe('active: 39 sessions');
  });

  it('reports no traffic when sessions is 0', () => {
    expect(computeTrafficVerdict({
      data: { sessions: '0' },
      range: 'Last 30 days',
    })).toBe('no traffic: 0 sessions in Last 30 days');
  });

  it('reports not measured when tag never fired (NOT_INSTALLED)', () => {
    expect(computeTrafficVerdict({
      readError: 'NOT_INSTALLED: Clarity redirected to Getting Started',
      range: 'Last 30 days',
    })).toBe('not measured: Clarity tag never fired — this says nothing about whether the site has visitors');
  });

  it('reports not found when project does not exist (NOT_FOUND)', () => {
    expect(computeTrafficVerdict({
      readError: 'NOT_FOUND: Clarity reported project does not exist',
      range: 'Last 30 days',
    })).toBe('not found: project does not exist or no permission');
  });

  it('reports unrecognised date range when Clarity ignored it', () => {
    expect(computeTrafficVerdict({
      readError: 'Clarity ignored the requested date range for proj: asked "Last 999 days"',
      range: 'Last 999 days',
    })).toBe('unknown: unrecognised date range "Last 999 days"');
  });

  it('reports unparseable sessions count', () => {
    expect(computeTrafficVerdict({
      data: { sessions: '-' },
      range: 'Last 30 days',
    })).toBe('unknown: sessions tile read as "-", not a plain count');
  });
});

describe('detailFor', () => {
  it('prefers the GTM account/container pair', () => {
    expect(detailFor({ account: '123', container: 'GTM-XXXX' })).toBe('account=123 container=GTM-XXXX');
  });

  it('falls back to the connected URL, and to empty when there is nothing', () => {
    expect(detailFor({ connectedTo: 'https://example.com' })).toBe('url=https://example.com');
    expect(detailFor({})).toBe('');
  });
});

describe('toCount parses formatted session counts', () => {
  it('parses plain numeric strings', () => {
    expect(toCount('42')).toBe(42);
    expect(toCount('0')).toBe(0);
  });

  it('strips commas from thousand-separated numbers', () => {
    expect(toCount('1,234')).toBe(1234);
    expect(toCount('1,234,567')).toBe(1234567);
  });

  it('returns null for non-integer or empty strings to distinguish from measured zero', () => {
    expect(toCount('')).toBeNull();
    expect(toCount(null)).toBeNull();
    expect(toCount(undefined)).toBeNull();
    expect(toCount('-')).toBeNull();
    expect(toCount('1.36')).toBeNull();
    expect(toCount('N/A')).toBeNull();
  });
});

describe('isRetriableNavigationError', () => {
  it('recognizes Navigation rejected error', () => {
    expect(isRetriableNavigationError(new Error('Navigation rejected.'))).toBe(true);
  });

  it('recognizes Detached while handling command error', () => {
    expect(isRetriableNavigationError(new Error('Detached while handling command.'))).toBe(true);
  });

  it('recognizes Debugger is not attached error', () => {
    expect(isRetriableNavigationError(new Error('Debugger is not attached'))).toBe(true);
  });

  it('recognizes Target closed error', () => {
    expect(isRetriableNavigationError(new Error('Protocol error (Target.navigate): Target closed.'))).toBe(true);
  });

  it('recognizes Session closed error', () => {
    expect(isRetriableNavigationError(new Error('Session closed. Most likely the page has been closed.'))).toBe(true);
  });

  it('rejects general non-navigation errors', () => {
    expect(isRetriableNavigationError(new Error('SyntaxError: Unexpected token'))).toBe(false);
    expect(isRetriableNavigationError(new Error('ReferenceError: foo is not defined'))).toBe(false);
  });
});

describe('safeGoto resilience', () => {
  it('succeeds on first attempt when goto works', async () => {
    const page = { goto: vi.fn().mockResolvedValue(undefined) };
    await safeGoto(page, 'https://example.com');
    expect(page.goto).toHaveBeenCalledTimes(1);
  });

  it('recovers via location.href evaluation when goto throws Navigation rejected', async () => {
    const page = {
      goto: vi.fn().mockRejectedValueOnce(new Error('Navigation rejected.')),
      evaluate: vi.fn().mockResolvedValue(undefined),
    };
    await safeGoto(page, 'https://example.com');
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.evaluate).toHaveBeenCalledWith('location.href = "https://example.com"');
  });

  it('recovers via location.href evaluation when goto throws Detached while handling command', async () => {
    const page = {
      goto: vi.fn().mockRejectedValueOnce(new Error('Detached while handling command.')),
      evaluate: vi.fn().mockResolvedValue(undefined),
    };
    await safeGoto(page, 'https://example.com');
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.evaluate).toHaveBeenCalledWith('location.href = "https://example.com"');
  });

  it('recovers via wait delay and second goto when evaluate fails', async () => {
    const page = {
      goto: vi.fn()
        .mockRejectedValueOnce(new Error('Navigation rejected.'))
        .mockResolvedValueOnce(undefined),
      evaluate: vi.fn().mockRejectedValueOnce(new Error('Context destroyed')),
    };
    await safeGoto(page, 'https://example.com');
    expect(page.goto).toHaveBeenCalledTimes(2);
  });

  it('recovers via newTab and setActivePage when second goto also rejects', async () => {
    const page = {
      goto: vi.fn()
        .mockRejectedValueOnce(new Error('Navigation rejected.'))
        .mockRejectedValueOnce(new Error('Navigation rejected.')),
      evaluate: vi.fn().mockRejectedValueOnce(new Error('Context destroyed')),
      newTab: vi.fn().mockResolvedValue('tab-123'),
      setActivePage: vi.fn().mockResolvedValue(undefined),
    };
    await safeGoto(page, 'https://example.com');
    expect(page.newTab).toHaveBeenCalledWith('https://example.com');
    expect(page.setActivePage).toHaveBeenCalledWith('tab-123');
  });

  it('rethrows errors that are not retriable navigation errors', async () => {
    const page = {
      goto: vi.fn().mockRejectedValue(new Error('Network error')),
    };
    await expect(safeGoto(page, 'https://example.com')).rejects.toThrow('Network error');
  });
});
