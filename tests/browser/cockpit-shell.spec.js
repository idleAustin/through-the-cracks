// End-to-end Playwright specs for the Thread Level Midnight cockpit shell, theme persistence, URL routing, and responsive layout.
import { expect, test } from '@playwright/test';

const ROUTES = [
  { label: 'Overview', path: '/', heading: null },
  { label: 'Artists', path: '/artists', heading: 'Artists', level: 1 },
  { label: 'Songs', path: '/songs', heading: 'Songs', level: 1 },
  { label: 'Episodes', path: '/episodes', heading: 'Episodes', level: 1 },
  { label: 'Search', path: '/search', heading: 'Global Catalog Search' },
];

const EXPECTED_FONT_FAMILIES = [
  'Fira Code:wght@400;500;600',
  'Geist:wght@400;500;600',
  'Outfit:wght@600;700',
];

function getThemeToggle(page) {
  return page.getByRole('button', { name: /Switch to (light|dark) theme/i });
}

test.describe('Thread Level Midnight cockpit shell', () => {
  test('loads Outfit/Geist/Fira Code weights only, removes Material Symbols, and paints --as-* surfaces', async ({ page }, testInfo) => {
    const isMobile = testInfo.project.name === 'mobile-375';
    await page.goto('/');

    await expect(page.locator('head link[href*="Material+Symbols"]')).toHaveCount(0);

    const fontCheck = await page.evaluate(() => {
      const links = [...document.querySelectorAll('head link[rel="stylesheet"][href*="fonts.googleapis.com"]')];
      const requestedFamilies = links.flatMap((link) => {
        try {
          return new URL(link.href).searchParams.getAll('family');
        } catch {
          return [];
        }
      });

      const importedFonts = [];
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule instanceof CSSImportRule && /fonts\.googleapis\.com/i.test(rule.href)) {
              importedFonts.push(rule.href);
            }
          }
        } catch {
          // Cross-origin stylesheets throw SecurityError on cssRules access.
        }
      }
      return { requestedFamilies: requestedFamilies.sort(), importedFonts };
    });

    expect(fontCheck.requestedFamilies).toEqual(EXPECTED_FONT_FAMILIES);
    expect(fontCheck.importedFonts).toEqual([]);

    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(10, 10, 12)');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(244, 244, 246)');
    await page.emulateMedia({ colorScheme: 'dark' });

    const wordmark = isMobile
      ? page.locator('.mobile-topbar').getByText('Through the Cracks')
      : page.locator('.cockpit-sidebar').getByText('Through the Cracks');
    await expect(wordmark).toBeVisible();
    const wordmarkFont = await wordmark.evaluate((el) => getComputedStyle(el).fontFamily);
    expect(wordmarkFont).toMatch(/Outfit/i);

    const overviewLink = page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Overview' });
    const navFont = await overviewLink.evaluate((el) => getComputedStyle(el).fontFamily);
    expect(navFont).toMatch(/Geist/i);

    const spinReadout = isMobile ? page.locator('#kpi-plays') : page.locator('.cockpit-spins');
    await expect(spinReadout).toBeVisible();
    const spinStyles = await spinReadout.evaluate((el) => {
      const s = getComputedStyle(el);
      return { fontFamily: s.fontFamily, fontVariantNumeric: s.fontVariantNumeric };
    });
    expect(spinStyles.fontFamily).toMatch(/Fira Code/i);
    expect(spinStyles.fontVariantNumeric).toContain('tabular-nums');
  });

  test('migrates legacy ttc-theme to as-theme on initial load', async ({ page }) => {
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('__seeded_ttc_theme')) {
        sessionStorage.setItem('__seeded_ttc_theme', '1');
        localStorage.removeItem('as-theme');
        localStorage.setItem('ttc-theme', 'light');
      }
    });

    await page.goto('/');
    const state = await page.evaluate(() => ({
      datasetTheme: document.documentElement.dataset.theme,
      asTheme: localStorage.getItem('as-theme'),
      ttcTheme: localStorage.getItem('ttc-theme'),
    }));
    expect(state).toEqual({
      datasetTheme: 'light',
      asTheme: 'light',
      ttcTheme: null,
    });
  });

  test('tracks OS colorScheme when unset and persists explicit as-theme with .theme-switching', async ({ page }) => {
    await page.goto('/');
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');

    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');

    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');

    await page.evaluate(() => {
      window.__themeSwitchingSawAdded = false;
      const root = document.documentElement;
      window.__themeSwitchingObserver = new MutationObserver(() => {
        if (root.classList.contains('theme-switching')) {
          window.__themeSwitchingSawAdded = true;
        }
      });
      window.__themeSwitchingObserver.observe(root, { attributes: true, attributeFilter: ['class'] });
    });

    const toggle = getThemeToggle(page);
    await expect(toggle).toHaveAccessibleName('Switch to light theme');
    await toggle.click();

    await expect
      .poll(
        () =>
          page.evaluate(() => ({
            sawAdded: window.__themeSwitchingSawAdded,
            stillPresent: document.documentElement.classList.contains('theme-switching'),
            datasetTheme: document.documentElement.dataset.theme,
            asTheme: localStorage.getItem('as-theme'),
          })),
        { timeout: 2500 },
      )
      .toEqual({
        sawAdded: true,
        stillPresent: false,
        datasetTheme: 'light',
        asTheme: 'light',
      });
    await expect(toggle).toHaveAccessibleName('Switch to dark theme');

    // Explicit stored preference ignores OS changes and persists across reload.
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');

    await page.reload();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
    expect(await page.evaluate(() => localStorage.getItem('as-theme'))).toBe('light');

    await getThemeToggle(page).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    expect(await page.evaluate(() => localStorage.getItem('as-theme'))).toBe('dark');
  });

  test('routes all 5 destinations via nav links, deep links, and browser history', async ({ page }) => {
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Primary navigation' });

    for (const route of [...ROUTES.slice(1), ROUTES[0]]) {
      const link = nav.getByRole('link', { name: route.label });
      await link.click();
      await expect(page).toHaveURL(route.path);
      expect(await page.evaluate(() => window.location.pathname)).toBe(route.path);
      await expect(link).toHaveAttribute('aria-current', 'page');
      await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
      if (route.heading) {
        await expect(page.getByRole('heading', { name: route.heading, ...(route.level ? { level: route.level } : {}) })).toBeVisible();
      } else {
        await expect(page.locator('#kpi-plays')).toBeVisible();
      }
    }

    for (const route of ROUTES.slice(1)) {
      await page.goto(route.path);
      await expect(page.getByRole('heading', { name: route.heading, ...(route.level ? { level: route.level } : {}) })).toBeVisible();
      await expect(nav.getByRole('link', { name: route.label })).toHaveAttribute('aria-current', 'page');
    }

    await page.goto('/artists');
    await expect(page.getByRole('heading', { name: 'Artists', level: 1 })).toBeVisible();
    await page.goto('/songs');
    await expect(page.getByRole('heading', { name: 'Songs', level: 1 })).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL('/artists');
    await expect(page.getByRole('heading', { name: 'Artists', level: 1 })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Artists' })).toHaveAttribute('aria-current', 'page');

    await page.goForward();
    await expect(page).toHaveURL('/songs');
    await expect(page.getByRole('heading', { name: 'Songs', level: 1 })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Songs' })).toHaveAttribute('aria-current', 'page');
  });

  test('enforces responsive desktop cockpit and mobile tab bar geometry with live/static telemetry', async ({ page }, testInfo) => {
    const isMobile = testInfo.project.name === 'mobile-375';
    await page.goto('/');

    if (!isMobile) {
      const sidebar = page.locator('.cockpit-sidebar');
      await expect(sidebar).toBeVisible();
      const sidebarBox = await sidebar.boundingBox();
      expect(sidebarBox.width).toBeGreaterThanOrEqual(248);
      expect(sidebarBox.width).toBeLessThanOrEqual(260);

      await expect(sidebar).toContainText('Through the Cracks');
      await expect(sidebar).toContainText('WEVL 89.9 · Static Snapshot');

      const quickJump = sidebar.getByRole('button', { name: /Quick jump/i });
      await expect(quickJump).toBeVisible();
      await expect(quickJump).toContainText(/⌘K|Ctrl\+K/);

      const activeLink = sidebar.locator('[aria-current="page"]');
      await expect(activeLink.locator('.nav-lime-dot')).toBeVisible();
      await expect(sidebar).toContainText(/36,902\s+spins/i);

      await getThemeToggle(page).focus();
      await expect(page.getByRole('tooltip')).toBeVisible();

      const canvasBox = await page.locator('.work-canvas').boundingBox();
      expect(canvasBox.width).toBeLessThanOrEqual(1200);

      await page.route('**/api/overview', async (route) => {
        const res = await route.fetch({ url: new URL('/data/overview.json', route.request().url()).toString() });
        await route.fulfill({ response: res });
      });
      await page.route('**/api/years*', async (route) => {
        const res = await route.fetch({ url: new URL('/data/year-spins.json', route.request().url()).toString() });
        const payload = await res.json();
        await route.fulfill({
          json: { years: payload.years, spins: payload.archive, scope: 'archive', artist: null, song: null },
        });
      });
      await page.route('**/api/artists*', async (route) => {
        const res = await route.fetch({ url: new URL('/data/artists.json', route.request().url()).toString() });
        const list = await res.json();
        await route.fulfill({
          json: { items: list.slice(0, 10), total: 10, pagination: { page: 1, limit: 10, total: 10, totalPages: 1 } },
        });
      });
      await page.route('**/api/songs*', async (route) => {
        const res = await route.fetch({ url: new URL('/data/songs.json', route.request().url()).toString() });
        const list = await res.json();
        await route.fulfill({
          json: { items: list.slice(0, 10), total: 10, pagination: { page: 1, limit: 10, total: 10, totalPages: 1 } },
        });
      });
      await page.goto('/');
      await expect(page.locator('.cockpit-sidebar')).toContainText('WEVL 89.9 · BigQuery Live');
      return;
    }

    await expect(page.locator('.cockpit-sidebar')).toBeHidden();

    const topbar = page.locator('.mobile-topbar');
    await expect(topbar).toBeVisible();
    const topbarBox = await topbar.boundingBox();
    expect(topbarBox.height).toBeGreaterThanOrEqual(50);
    expect(topbarBox.height).toBeLessThanOrEqual(56);
    await expect(topbar).toContainText('Through the Cracks');
    await expect(topbar).toContainText('WEVL 89.9 FM');

    const mobileThemeBox = await getThemeToggle(page).boundingBox();
    expect(mobileThemeBox.width).toBeGreaterThanOrEqual(44);
    expect(mobileThemeBox.height).toBeGreaterThanOrEqual(44);

    const tabBar = page.locator('.mobile-bottom-tabs');
    await expect(tabBar).toBeVisible();
    for (const route of ROUTES) {
      const link = tabBar.getByRole('link', { name: route.label });
      await expect(link).toBeVisible();
      const box = await link.boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(44);
    }

    for (const route of ROUTES) {
      await tabBar.getByRole('link', { name: route.label }).click();
      await expect(tabBar.getByRole('link', { name: route.label })).toHaveAttribute('aria-current', 'page');
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
    }
  });
});
