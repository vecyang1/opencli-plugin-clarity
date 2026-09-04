import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import { statusOf } from './audit.js';
import { detailFor, normalizeProjectId, safeGoto } from './_ui.js';
import { toCount } from './traffic.js';
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

  it('rethrows errors that are not Navigation rejected', async () => {
    const page = {
      goto: vi.fn().mockRejectedValue(new Error('Network error')),
    };
    await expect(safeGoto(page, 'https://example.com')).rejects.toThrow('Network error');
  });
});
