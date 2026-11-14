// End-to-end Playwright specs for the Search Artist Dashboard: auto-open, year/month visualizations, leaderboards, states, theme, and 320px mobile checks.
import { expect, test } from '@playwright/test';

const trackErrors = (page) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  return errors;
};

const checkNoOverflow = async (page) => {
  const dims = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(dims.scrollWidth).toBeLessThanOrEqual(dims.innerWidth);
};

const expectTapTarget = async (locator, { checkWidth = false } = {}) => {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
  if (checkWidth) expect(box.width).toBeGreaterThanOrEqual(44);
};

const checkBarAlignment = async (page) => {
  const metrics = await page.evaluate(() => {
    const tracks = Array.from(document.querySelectorAll('.ad-bar-track'));
    const bottoms = tracks.map((el) => el.getBoundingClientRect().bottom);
    const evenBottoms = bottoms.filter((_, i) => i % 2 === 0);
    const oddBottoms = bottoms.filter((_, i) => i % 2 === 1);
    const altHidden = Array.from(document.querySelectorAll('.ad-bar-label.is-alt')).every(
      (el) => getComputedStyle(el).visibility === 'hidden',
    );
    return {
      count: tracks.length,
      spread: Math.max(...bottoms) - Math.min(...bottoms),
      evenOddDiff: Math.abs(evenBottoms[0] - oddBottoms[0]),
      altHidden,
    };
  });
  expect(metrics.count).toBeGreaterThanOrEqual(4);
  expect(metrics.spread).toBeLessThanOrEqual(1);
  expect(metrics.evenOddDiff).toBeLessThanOrEqual(1);
  expect(metrics.altHidden).toBe(true);
};

test.describe('Search Artist Dashboard', () => {
  test('auto-opens single-Artist query, prevents Back loop, skips multi-Artist auto-open, and re-enables for a new query', async ({ page }) => {
    await page.goto('/search?q=Cory+Branan');

    await expect.poll(() => {
      const u = new URL(page.url());
      return [u.searchParams.get('q'), u.searchParams.get('artist')];
    }).toEqual(['Cory Branan', 'Cory Branan']);

    const dashboard = page.getByLabel('Cory Branan dashboard');
    await expect(dashboard).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Cory Branan', level: 1 })).toBeVisible();
    await expect(dashboard).toContainText(/#40\s*of 1,917 artists by spins/);

    const kpiGrid = page.getByLabel('Artist summary metrics');
    await expect(kpiGrid.locator('.ad-kpi')).toHaveCount(6);
    for (const label of ['Spins', 'Episodes', 'Songs', 'Albums', 'Avg gap', 'Last spin']) {
      await expect(kpiGrid).toContainText(label);
    }

    await expect(page.getByRole('heading', { name: 'Spins by year', level: 2 })).toBeVisible();
    const rotation = page.getByLabel('Rotation');
    await expect(rotation).toContainText('Opened an episode');
    await expect(rotation).toContainText('Closed an episode');

    await expect(page.locator('#ad-top-songs')).toContainText('Top songs');
    await expect(page.locator('#ad-top-albums')).toContainText('Top albums');
    await expect(page.locator('#ad-played-alongside')).toContainText('Played alongside');

    await page.getByRole('button', { name: 'Back to results' }).click();
    await expect.poll(() => {
      const u = new URL(page.url());
      return [u.searchParams.get('q'), u.searchParams.has('artist')];
    }).toEqual(['Cory Branan', false]);

    await expect(page.getByRole('heading', { name: 'Catalog Search', level: 1 })).toBeVisible();
    await expect(page.locator('#search-artists-section')).toBeVisible();
    await expect(page.locator('.ad-wrap')).toHaveCount(0);

    const searchInput = page.locator('#global-search-input');
    await searchInput.fill('Prine');
    await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('Prine');
    await expect(page.locator('#search-artists-section')).toContainText('John Prine');
    await expect.poll(() => new URL(page.url()).searchParams.has('artist')).toBe(false);
    await expect(page.locator('.ad-wrap')).toHaveCount(0);

    await page.locator('#search-artists-section').getByText('John Prine', { exact: true }).first().click();
    await expect.poll(() => new URL(page.url()).searchParams.get('artist')).toBe('John Prine');
    await expect(page.getByRole('heading', { name: 'John Prine', level: 1 })).toBeVisible();

    await searchInput.fill('Cory Branan');
    await expect.poll(() => {
      const u = new URL(page.url());
      return [u.searchParams.get('q'), u.searchParams.get('artist')];
    }).toEqual(['Cory Branan', 'Cory Branan']);
    await expect(page.getByRole('heading', { name: 'Cory Branan', level: 1 })).toBeVisible();

    await searchInput.fill('cory brana');
    await expect.poll(() => {
      const u = new URL(page.url());
      return [u.searchParams.get('q'), u.searchParams.get('artist')];
    }).toEqual(['cory brana', 'Cory Branan']);
    await expect(page.getByRole('heading', { name: 'Cory Branan', level: 1 })).toBeVisible();
  });

  test('switches Bars <-> Heatmap, opens active month drawer with episode links, and toggles closed', async ({ page }) => {
    await page.goto('/search?artist=Cory+Branan');
    await expect(page.getByRole('heading', { name: 'Cory Branan', level: 1 })).toBeVisible();

    const barsBtn = page.getByRole('button', { name: 'Bars', exact: true });
    const heatmapBtn = page.getByRole('button', { name: 'Heatmap', exact: true });
    await expect(barsBtn).toHaveAttribute('aria-pressed', 'true');

    await heatmapBtn.click();
    await expect(heatmapBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('heading', { name: 'When it aired', level: 2 })).toBeVisible();

    const augCell = page.getByRole('button', { name: /August 2023: \d+ spin/i });
    await augCell.click();
    await expect(augCell).toHaveAttribute('aria-pressed', 'true');

    const drawer = page.getByLabel('August 2023 airings');
    await expect(drawer).toBeVisible();
    const episodeLinks = drawer.locator('a[href^="/episodes?episode="]');
    expect(await episodeLinks.count()).toBeGreaterThanOrEqual(1);

    const nonTopSongBtn = drawer.locator('.ad-drawer-song-btn', { hasText: 'Honey Come Home' });
    await expect(nonTopSongBtn).toHaveAttribute('aria-expanded', 'false');
    await nonTopSongBtn.click();
    await expect(nonTopSongBtn).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.ad-month-drawer .ad-airing-chips a[href^="/episodes?episode="]').first()).toBeVisible();
    await expect(page.locator('#ad-top-songs button[aria-expanded="true"]')).toHaveCount(0);

    const topDrawerSongBtn = drawer.locator('.ad-drawer-song-btn', { hasText: 'Gatlinburg' });
    await topDrawerSongBtn.click();
    await expect(topDrawerSongBtn).toHaveAttribute('aria-expanded', 'true');
    await expect(nonTopSongBtn).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.ad-month-drawer .ad-airing-chips a[href^="/episodes?episode="]').first()).toBeVisible();
    await expect(page.locator('#ad-top-songs button[aria-expanded="true"]')).toContainText('Gatlinburg');

    await topDrawerSongBtn.click();
    await expect(topDrawerSongBtn).toHaveAttribute('aria-expanded', 'false');
    await expect(drawer.locator('.ad-airing-chips')).toHaveCount(0);
    await expect(page.locator('#ad-top-songs button[aria-expanded="true"]')).toHaveCount(0);

    await augCell.click();
    await expect(drawer).toHaveCount(0);

    await augCell.click();
    await expect(drawer).toBeVisible();
    await drawer.getByRole('button', { name: 'Close' }).click();
    await expect(drawer).toHaveCount(0);

    await barsBtn.click();
    await expect(page.getByRole('heading', { name: 'Spins by year', level: 2 })).toBeVisible();
  });

  test('expands Top songs air-date chips to navigate to /episodes and switches Artist via Played alongside', async ({ page }) => {
    await page.goto('/search?artist=Cory+Branan');
    await expect(page.getByRole('heading', { name: 'Cory Branan', level: 1 })).toBeVisible();

    const firstSongBtn = page.locator('#ad-top-songs button.ad-rank-row').first();
    await expect(firstSongBtn).toHaveAttribute('aria-expanded', 'false');
    await firstSongBtn.click();
    await expect(firstSongBtn).toHaveAttribute('aria-expanded', 'true');

    const chips = page.locator('#ad-top-songs .ad-airing-chips a[href^="/episodes?episode="]');
    await expect(chips.first()).toBeVisible();
    await chips.first().click();

    await expect(page).toHaveURL(/\/episodes\?episode=/);
    await expect(page.locator('.playlist-pane')).toBeVisible();

    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Cory Branan', level: 1 })).toBeVisible();

    const alongsideBtn = page.locator('#ad-played-alongside button.ad-rank-row').first();
    const nextArtist = (await alongsideBtn.locator('.ad-rank-name').textContent()).trim();
    await alongsideBtn.click();

    await expect.poll(() => new URL(page.url()).searchParams.get('artist')).toBe(nextArtist);
    await expect(page.getByRole('heading', { name: nextArtist, level: 1 })).toBeVisible();
  });

  test('renders deadpan empty state with Back to results for unknown artist without errors', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/search?artist=No+Such+Artist+9999');

    await expect(page.getByRole('heading', { name: 'No artist matches that name in the archive.' })).toBeVisible();
    const backBtn = page.getByRole('button', { name: 'Back to results' });
    await expect(backBtn).toBeVisible();
    await expect(backBtn).toBeEnabled();

    await backBtn.click();
    await expect.poll(() => new URL(page.url()).searchParams.has('artist')).toBe(false);
    await expect(page.getByRole('heading', { name: 'Catalog Search', level: 1 })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('renders visible chart fills in light/dark themes and passes 320px overflow and tap-target checks', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/search?artist=Cory+Branan');
    await expect(page.getByRole('heading', { name: 'Cory Branan', level: 1 })).toBeVisible();

    const themeBtn = page.locator('.mobile-theme-btn:visible, .cockpit-sidebar button[aria-label*="theme"]:visible').first();
    await themeBtn.click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');

    const barFills = await page.evaluate(() => {
      const regular = document.querySelector('.ad-bar-col:not(.is-zero):not(.is-peak) .ad-bar-fill');
      const peak = document.querySelector('.ad-bar-col.is-peak .ad-bar-fill');
      return {
        regularBg: regular ? getComputedStyle(regular).backgroundColor : '',
        peakBg: peak ? getComputedStyle(peak).backgroundColor : '',
      };
    });
    expect(barFills.regularBg).not.toMatch(/^(|transparent|rgba\(0,\s*0,\s*0,\s*0\))$/);
    expect(barFills.peakBg).not.toMatch(/^(|transparent|rgba\(0,\s*0,\s*0,\s*0\))$/);

    const heatmapBtn = page.getByRole('button', { name: 'Heatmap', exact: true });
    await heatmapBtn.click();
    const l0Bg = await page.locator('.ah-grid .ah-cell.l0:not(.is-out)').first().evaluate((el) => getComputedStyle(el).backgroundColor);
    const activeCellBg = await page.locator('.ah-grid button.ah-cell').first().evaluate((el) => getComputedStyle(el).backgroundColor);
    const panelBg = await page.locator('.ad-panel').first().evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(l0Bg).not.toMatch(/^(|transparent|rgba\(0,\s*0,\s*0,\s*0\))$/);
    expect(activeCellBg).not.toMatch(/^(|transparent|rgba\(0,\s*0,\s*0,\s*0\))$/);
    expect(l0Bg).not.toBe(panelBg);
    expect(activeCellBg).not.toBe(l0Bg);

    await themeBtn.click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    await page.evaluate(() => localStorage.removeItem('as-theme'));

    await page.setViewportSize({ width: 320, height: 720 });
    await checkNoOverflow(page);
    const barsBtn = page.getByRole('button', { name: 'Bars', exact: true });
    for (const control of [
      page.getByRole('button', { name: 'Back to results' }),
      barsBtn,
      heatmapBtn,
      page.locator('#ad-top-songs button.ad-rank-row').first(),
    ]) {
      await expectTapTarget(control);
    }

    await barsBtn.click();
    await expect(page.getByRole('heading', { name: 'Spins by year', level: 2 })).toBeVisible();
    await checkNoOverflow(page);
    expect(errors).toEqual([]);
  });

  test('passes mobile-375, 320x720, and 430x932 KPI fit, bar alignment, touch reset, heatmap, drawer, and tap-target checks', async ({ page }, testInfo) => {
    if (testInfo.project.name !== 'mobile-375') return;
    const errors = trackErrors(page);

    await page.goto('/search?artist=Cory+Branan');
    await expect(page.getByRole('heading', { name: 'Cory Branan', level: 1 })).toBeVisible();
    await checkNoOverflow(page);
    await checkBarAlignment(page);

    const yearCap = page.locator('.ad-year-cap');
    await expect(yearCap).toContainText('Peak year: 2023');
    const bar2024 = page.getByRole('button', { name: /^2024:/ });
    await bar2024.tap();
    await expect(bar2024).toHaveAttribute('aria-pressed', 'true');
    await expect(yearCap).toContainText('2024:');
    await bar2024.tap();
    await expect(bar2024).toHaveAttribute('aria-pressed', 'false');
    await expect(yearCap).toContainText('Peak year: 2023');

    await page.locator('#ad-top-songs button.ad-rank-row').first().tap();
    await expectTapTarget(page.locator('#ad-top-songs .ad-chip').first());
    await expectTapTarget(page.locator('#ad-played-alongside button.ad-rank-row').first());

    await page.getByRole('button', { name: 'Heatmap', exact: true }).tap();
    const cellMetrics = await page.evaluate(() => {
      const grid = document.querySelector('.ah-grid');
      const rects = Array.from(document.querySelectorAll('.ah-grid .ah-cell')).map((el) => el.getBoundingClientRect());
      return {
        count: rects.length,
        gridFits: Boolean(grid && grid.scrollWidth <= grid.clientWidth + 1),
        allSquare: rects.every((r) => r.width >= 8 && r.height >= 8 && Math.abs(r.width - r.height) <= 1.5),
      };
    });
    expect(cellMetrics.count).toBeGreaterThan(0);
    expect(cellMetrics.gridFits).toBe(true);
    expect(cellMetrics.allSquare).toBe(true);

    const monthSelect = page.locator('.ad-month-select');
    await expectTapTarget(monthSelect);
    expect(await monthSelect.evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px');
    await monthSelect.selectOption('2023-08');

    const drawer = page.locator('.ad-month-drawer');
    await expect(drawer).toBeVisible();
    await expectTapTarget(drawer.locator('.ad-drawer-close'), { checkWidth: true });
    await expectTapTarget(drawer.locator('.ad-drawer-song-btn').first(), { checkWidth: true });
    await expectTapTarget(drawer.locator('.ad-chip').first());
    await checkNoOverflow(page);

    await page.setViewportSize({ width: 430, height: 932 });
    await expect(drawer).toBeVisible();
    await checkNoOverflow(page);

    await page.setViewportSize({ width: 320, height: 720 });
    await expect(drawer).toBeVisible();
    await checkNoOverflow(page);

    const mobileDrawerSongBtn = drawer.locator('.ad-drawer-song-btn').first();
    await mobileDrawerSongBtn.tap();
    await expect(mobileDrawerSongBtn).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.ad-month-drawer .ad-airing-chips a[href^="/episodes?episode="]').first()).toBeVisible();
    await expect(page.locator('#ad-top-songs button[aria-expanded="true"]')).toHaveCount(1);
    await checkNoOverflow(page);
    await mobileDrawerSongBtn.tap();
    await expect(mobileDrawerSongBtn).toHaveAttribute('aria-expanded', 'false');
    await checkNoOverflow(page);

    await page.getByRole('button', { name: 'Bars', exact: true }).tap();
    await expect(page.getByRole('heading', { name: 'Spins by year', level: 2 })).toBeVisible();
    await checkBarAlignment(page);
    await checkNoOverflow(page);

    await page.goto(`/search?artist=${encodeURIComponent('A Tribute To Guy Clark (November 6, 1941')}`);
    await expect(page.getByRole('heading', { name: 'A Tribute To Guy Clark (November 6, 1941', level: 1 })).toBeVisible();
    await expect(page.locator('.ad-kpi', { hasText: 'Last spin' }).locator('.ad-kpi-val')).toContainText('3,825d');
    const kpiFits = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.ad-kpi')).every((cell) => {
        const val = cell.querySelector('.ad-kpi-val');
        if (!val) return false;
        return val.scrollWidth <= val.clientWidth && val.getBoundingClientRect().right <= cell.getBoundingClientRect().right + 1;
      }),
    );
    expect(kpiFits).toBe(true);
    await checkNoOverflow(page);
    expect(errors).toEqual([]);
  });
});
