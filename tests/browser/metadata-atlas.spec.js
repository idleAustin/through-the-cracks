// End-to-end Playwright specs for /atlas Metadata Atlas cross-filtering, ARIA roving/groups, Escape step-back, and mobile geometry.
import { expect, test } from '@playwright/test';

function trackPageErrors(page) {
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));
  return { consoleErrors, pageErrors };
}

async function assertNoHorizontalOverflow(page) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth);
}

async function assertMobileChromeGeometry(page) {
  const topbar = page.locator('.mobile-topbar');
  await expect(topbar).toBeVisible();
  const topbarBox = await topbar.boundingBox();
  expect(topbarBox.height).toBeGreaterThanOrEqual(50);
  expect(topbarBox.height).toBeLessThanOrEqual(56);

  const actionRects = await page.evaluate(() =>
    [...document.querySelectorAll('.mobile-topbar-actions > *')].map((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width, height: r.height };
    }),
  );
  expect(actionRects).toHaveLength(3);
  for (const box of actionRects) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  for (let i = 1; i < actionRects.length; i += 1) {
    expect(actionRects[i].left - actionRects[i - 1].right).toBeGreaterThanOrEqual(6);
  }

  const tabMetrics = await page.evaluate(() =>
    [...document.querySelectorAll('.mobile-bottom-tabs .mobile-tab-link')].map((el) => {
      const rect = el.getBoundingClientRect();
      const label = el.querySelector('.mobile-tab-label');
      return { width: rect.width, height: rect.height, clipped: label ? label.scrollWidth > label.clientWidth + 1 : false };
    }),
  );
  expect(tabMetrics).toHaveLength(5);
  for (const tab of tabMetrics) {
    expect(tab.width).toBeGreaterThanOrEqual(54);
    expect(tab.height).toBeGreaterThanOrEqual(44);
    expect(tab.clipped).toBe(false);
  }
}

async function assertMobileAtlasLayoutAndFilters(page) {
  await expect(page.locator('.atlas-treemap-svg')).toHaveCount(0);
  const firstYearBtn = page.locator('ol.atlas-mobile-years .atlas-mobile-year-btn').first();
  await expect(firstYearBtn).toBeVisible();
  expect((await firstYearBtn.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await expect(page.locator('.era-stack-bar[aria-hidden="true"]')).toBeVisible();
  await expect(page.locator('.era-stack-bar button')).toHaveCount(0);

  const segChecks = await page.evaluate(() =>
    [...document.querySelectorAll('.atlas-page .seg-group')].map((group) => {
      const rects = [...group.querySelectorAll('.seg-btn')].map((b) => b.getBoundingClientRect());
      const gaps = [];
      for (let i = 1; i < rects.length; i += 1) {
        const a = rects[i - 1];
        const b = rects[i];
        gaps.push(Math.abs(a.top - b.top) < 4 ? b.left - a.right : b.top - a.bottom);
      }
      return { heights: rects.map((r) => r.height), gaps };
    }),
  );
  expect(segChecks.length).toBeGreaterThan(0);
  for (const g of segChecks) {
    for (const h of g.heights) expect(h).toBeGreaterThanOrEqual(44);
    for (const gap of g.gaps) expect(gap).toBeGreaterThanOrEqual(6);
  }

  const gridCols = await page.evaluate(() => ({
    workbench: getComputedStyle(document.querySelector('.atlas-workbench')).gridTemplateColumns.trim().split(/\s+/).length,
    spotlight: getComputedStyle(document.querySelector('.atlas-spotlight-grid')).gridTemplateColumns.trim().split(/\s+/).length,
  }));
  expect(gridCols).toEqual({ workbench: 1, spotlight: 1 });

  await page.locator('#atlas-state-select').selectOption('TX');
  await expect(page.getByRole('heading', { name: /Spotlight: Texas \(TX\)/ })).toBeVisible();
  await firstYearBtn.click();
  await expect(page).toHaveURL(/state=TX/);
  await expect(page).toHaveURL(/year=\d{4}/);

  const timeTab = page.getByRole('tablist', { name: 'Curiosity category' }).getByRole('tab', { name: 'Time-Capsule Gaps' });
  await timeTab.click();
  await expect(timeTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.data-table')).toHaveCount(0);
  await expect(page.locator('#curio-tabpanel .playlist-mobile-list .playlist-mobile-row').first()).toBeVisible();
  await assertNoHorizontalOverflow(page);
}

test.describe('Metadata Atlas (/atlas)', () => {
  test('desktop: navigates via CockpitSidebar, verifies ARIA groups & tab roving, Escape step-back, URL state, /prototype, and Ctrl+K', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Desktop Metadata Atlas spec');
    const { consoleErrors, pageErrors } = trackPageErrors(page);

    await page.goto('/');
    const atlasNavLink = page.locator('.cockpit-nav').getByRole('link', { name: 'Atlas' });
    await atlasNavLink.click();
    await expect(page).toHaveURL('/atlas');
    await expect(atlasNavLink).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.cockpit-nav .cockpit-nav-link')).toHaveText([
      'Overview', 'Artists', 'Songs', 'Episodes', 'Atlas', 'Playlist', 'Search',
    ]);
    await expect(page.getByRole('heading', { name: 'Metadata Atlas', level: 1 })).toBeVisible();

    const readouts = page.locator('.readout-cell');
    await expect(readouts).toHaveCount(4);
    for (let i = 0; i < 4; i += 1) await expect(readouts.nth(i)).toBeVisible();

    await expect(page.locator('.atlas-scope-badge')).toHaveText('Top 24 Peak Years');
    await expect(page.locator('.atlas-treemap-svg')).toHaveAttribute('role', 'group');
    await expect(page.locator('.atlas-treemap-svg .atlas-year-tile')).toHaveCount(24);

    const mapSvg = page.locator('.atlas-map-svg');
    await expect(mapSvg).toHaveAttribute('role', 'group');
    await expect(mapSvg.locator('.atlas-state-path')).toHaveCount(51);
    for (const stateName of ['Alaska', 'Hawaii', 'Tennessee', 'Texas']) {
      await expect(mapSvg.getByRole('button', { name: new RegExp(`^${stateName}:`) })).toBeVisible();
    }
    await expect(page.getByRole('heading', { name: /Spotlight: Tennessee \(TN\)/ })).toBeVisible();

    await page.getByRole('group', { name: /Quick select top states/i }).getByRole('button', { name: /^TX/ }).click();
    await page.getByRole('group', { name: 'Focus decade' }).getByRole('button', { name: '70s', exact: true }).click();
    await expect(page).toHaveURL(/era=1970s/);
    await expect(page.locator('.atlas-scope-badge')).toContainText('1970s');
    await expect(page.getByLabel('US studio and artist map').locator('.atlas-readout')).toContainText('1970s');

    await page.locator('.atlas-treemap-svg .atlas-year-hit').first().click();
    await expect(page).toHaveURL(/state=TX/);
    await expect(page).toHaveURL(/era=1970s/);
    await expect(page).toHaveURL(/year=197\d/);

    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/state=TX/);
    await expect(page).toHaveURL(/era=1970s/);
    await expect(page).not.toHaveURL(/year=/);

    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/state=TX/);
    await expect(page).not.toHaveURL(/era=/);

    await page.keyboard.press('Escape');
    await expect(page).not.toHaveURL(/state=/);
    await expect(page.getByRole('heading', { name: /Spotlight: Tennessee \(TN\)/ })).toBeVisible();

    // Quick back-to-back triple Escape with state + era + year active clears year -> era -> state cleanly.
    await page.getByRole('group', { name: /Quick select top states/i }).getByRole('button', { name: /^TX/ }).click();
    await page.getByRole('group', { name: 'Focus decade' }).getByRole('button', { name: '70s', exact: true }).click();
    await page.locator('.atlas-treemap-svg .atlas-year-hit').first().click();
    await expect(page).toHaveURL(/year=197\d/);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page).not.toHaveURL(/state=|era=|year=/);

    await page.getByRole('group', { name: /Quick select top states/i }).getByRole('button', { name: /^TX/ }).click();
    await page.getByRole('group', { name: 'Map layer mode' }).getByRole('button', { name: 'Artist From' }).click();
    await page.getByRole('group', { name: 'Treemap count metric' }).getByRole('button', { name: 'Total Spins' }).click();

    const producersTab = page.locator('#curio-tab-producers');
    const writersTab = page.locator('#curio-tab-writers');
    const tabPanel = page.locator('#curio-tabpanel');
    await producersTab.focus();
    await page.keyboard.press('ArrowRight');
    await expect(writersTab).toHaveAttribute('aria-selected', 'true');
    await expect(writersTab).toBeFocused();
    await expect(tabPanel).toHaveAttribute('aria-labelledby', 'curio-tab-writers');
    await page.keyboard.press('Home');
    await expect(producersTab).toHaveAttribute('aria-selected', 'true');
    await expect(producersTab).toBeFocused();
    await expect(tabPanel).toHaveAttribute('aria-labelledby', 'curio-tab-producers');

    await page.getByRole('tablist', { name: 'Curiosity category' }).getByRole('tab', { name: 'Time-Capsule Gaps' }).click();
    await expect.poll(() => {
      const sp = new URL(page.url()).searchParams;
      return { state: sp.get('state'), lens: sp.get('lens'), metric: sp.get('metric'), tab: sp.get('tab') };
    }).toEqual({ state: 'TX', lens: 'artist', metric: 'spins', tab: 'timeCapsules' });

    await page.reload();
    await expect(page.getByRole('heading', { name: /Spotlight: Texas \(TX\)/ })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Map layer mode' }).getByRole('button', { name: 'Artist From' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('group', { name: 'Treemap count metric' }).getByRole('button', { name: 'Total Spins' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#curio-tab-timeCapsules')).toHaveAttribute('aria-selected', 'true');

    await page.getByRole('button', { name: 'Clear All' }).click();
    await expect(page).not.toHaveURL(/state=|era=|year=/);
    await expect(page.getByRole('heading', { name: /Spotlight: Tennessee \(TN\)/ })).toBeVisible();

    for (const legacyPath of ['/prototype', '/prototype/anything']) {
      await page.goto(legacyPath);
      await expect(page).toHaveURL('/atlas');
      await expect(page.getByRole('heading', { name: 'Metadata Atlas', level: 1 })).toBeVisible();
    }

    await page.goto('/');
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await palette.getByRole('button', { name: /Atlas/i }).first().click();
    await expect(page).toHaveURL('/atlas');
    await assertNoHorizontalOverflow(page);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test('mobile 375x812: checks topbar/tab/seg targets, mobile ranked years, #atlas-state-select, theme toggle, and zero overflow', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-375', 'Mobile Metadata Atlas spec');
    const { consoleErrors, pageErrors } = trackPageErrors(page);

    await page.goto('/');
    await assertMobileChromeGeometry(page);
    const mobileAtlasLink = page.locator('.mobile-topbar').getByRole('link', { name: 'Atlas' });
    await mobileAtlasLink.click();
    await expect(page).toHaveURL('/atlas');
    await expect(mobileAtlasLink).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: 'Metadata Atlas', level: 1 })).toBeVisible();

    await assertMobileAtlasLayoutAndFilters(page);

    const themeToggle = page.getByRole('button', { name: /Switch to (light|dark) theme/i });
    await themeToggle.click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
    await themeToggle.click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test('mobile 320x667: keeps topbar/tabs/seg targets >= 44px with >= 6px gaps, mobile ranked years, and zero post-filter overflow', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-375', 'Narrow mobile Metadata Atlas spec');
    const { consoleErrors, pageErrors } = trackPageErrors(page);
    await page.setViewportSize({ width: 320, height: 667 });

    await page.goto('/');
    await assertMobileChromeGeometry(page);
    await page.locator('.mobile-topbar').getByRole('link', { name: 'Atlas' }).click();
    await expect(page).toHaveURL('/atlas');
    await expect(page.getByRole('heading', { name: 'Metadata Atlas', level: 1 })).toBeVisible();

    await assertMobileAtlasLayoutAndFilters(page);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
