// End-to-end Playwright specs for Ticket 05 Overview telemetry, dynamic Annual Spin chart, and asymmetric linked cards.
import { expect, test } from '@playwright/test';
import { EXPECTED } from './snapshot-expected.js';

test.describe('Overview telemetry, dynamic Annual Spin Volume chart, and asymmetric cards', () => {
  test('renders Latest Broadcast CTA, 4-cell Readout Strip, and zero horizontal overflow on mobile', async ({ page }, testInfo) => {
    const isMobile = testInfo.project.name === 'mobile-375';
    await page.goto('/');

    await expect(page.locator('#kpi-plays')).toHaveText(EXPECTED.totalSpinsFmt);
    await expect(page.locator('#kpi-episodes')).toHaveText(EXPECTED.totalEpisodesFmt);
    await expect(page.locator('#kpi-artists')).toHaveText(EXPECTED.uniqueArtistsFmt);
    await expect(page.locator('#kpi-songs')).toHaveText(EXPECTED.uniqueSongsFmt);

    if (isMobile) {
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
    }

    const latestCta = page.getByRole('link', { name: `Latest Broadcast (${EXPECTED.latestAirDateShort})` })
      .or(page.getByRole('button', { name: `Latest Broadcast (${EXPECTED.latestAirDateShort})` }));
    await expect(latestCta).toBeVisible();
    await latestCta.click();
    await expect(page).toHaveURL(`/episodes?episode=${EXPECTED.latestEpisodeId}`);
  });

  test('plots Annual Spin Volume with lime peak, replots on Artist & Song clicks, and resets via All Archive', async ({ page }, testInfo) => {
    const isMobile = testInfo.project.name === 'mobile-375';
    await page.goto('/');

    const chart = page.locator('.year-bars');
    await expect(chart).toBeVisible();
    await expect(chart.locator('.year-col')).toHaveCount(EXPECTED.yearCount);
    await expect(chart.locator('.year-col.is-peak .year-val')).toBeVisible();

    const toddItem = isMobile
      ? page.locator('.m-card-stack .m-card').filter({ hasText: 'Todd Snider' }).first()
      : page.locator('table tbody tr').filter({ hasText: 'Todd Snider' }).first();
    await toddItem.click();

    await expect(page).toHaveURL(/[?&]artist=Todd(%20|\+)Snider/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('main')).toContainText(/Annual Spins.*Todd Snider/i);
    await expect(chart.locator('.year-col.is-peak .year-val')).toHaveText(EXPECTED.toddSniderPeakSpins);

    const songItem = isMobile
      ? page.locator('.m-card-stack .m-card').filter({ hasText: 'Handsome John' }).first()
      : page.locator('table tbody tr').filter({ hasText: 'Handsome John' }).first();
    await songItem.click();

    await expect(page).toHaveURL(/[?&]song=Handsome(%20|\+)John/);
    await expect(page.locator('main')).toContainText(/Annual Spins.*Handsome John/i);
    const viewAirDates = page.getByRole('button', { name: /View Air Dates/i })
      .or(page.getByRole('link', { name: /View Air Dates/i }));
    await expect(viewAirDates).toBeVisible();

    await page.getByRole('button', { name: 'All Archive' }).click();
    await expect(page.locator('main')).toContainText(`Annual Spin Volume (${EXPECTED.yearRangeLabel})`);

    await songItem.click();
    await viewAirDates.click();
    await expect(page).toHaveURL(/\/episodes\?song=Handsome(%20|\+)John&artist=Todd(%20|\+)Snider/);

    await page.goto('/?artist=Todd%20Snider');
    await expect(page.locator('main')).toContainText(/Songs · Todd Snider/i);
    await expect(page.locator('main')).toContainText(/Annual Spins · Todd Snider/i);
    await expect(chart.locator('.year-col.is-peak .year-val')).toHaveText(EXPECTED.toddSniderPeakSpins);
  });

  test('supports Most Obscure toggle, Top cap/footer pagination, in-place Songs scoping, and Air dates action', async ({ page }, testInfo) => {
    const isMobile = testInfo.project.name === 'mobile-375';
    await page.goto('/');

    await page.getByRole('button', { name: 'Most Obscure' }).click();
    await expect(page).toHaveURL(/rank=obscure/);
    await expect(page.locator('main')).toContainText('Obscure Artists');
    await expect(page.locator('main')).toContainText('Obscure Songs');

    await page.getByRole('button', { name: 'Most Played' }).click();
    await expect(page).not.toHaveURL(/rank=obscure/);

    const capSelect = page.getByRole('combobox', { name: /List cap/i });
    await capSelect.selectOption('25');
    await expect(page).toHaveURL(/cap=25/);

    const artistsNext = page.getByRole('navigation', { name: /artists pagination/i }).getByRole('button', { name: /Next/i });
    await artistsNext.click();
    await expect(page).toHaveURL(/apage=2/);

    const songsNext = page.getByRole('navigation', { name: /songs pagination/i }).getByRole('button', { name: /Next/i });
    await songsNext.click();
    await expect(page).toHaveURL(/spage=2/);

    await page.goto('/');
    const toddItem = isMobile
      ? page.locator('.m-card-stack .m-card').filter({ hasText: 'Todd Snider' }).first()
      : page.locator('table tbody tr').filter({ hasText: 'Todd Snider' }).first();
    await toddItem.click();

    const songsCard = page.locator('section').filter({ has: page.getByRole('heading', { name: /Songs · Todd Snider/i }) });
    await expect(songsCard).toBeVisible();
    await expect(page.getByRole('button', { name: 'All Artists' })).toBeVisible();

    if (!isMobile) {
      const headerTexts = (await songsCard.locator('thead th').allInnerTexts()).map((t) => t.trim()).filter(Boolean);
      expect(headerTexts).toEqual(['#', 'Song', 'Artist', 'Album', 'Spins']);
      const airDatesBtn = songsCard.locator('tbody tr').filter({ hasText: 'Handsome John' }).first()
        .getByRole('button', { name: /Air dates|View air dates/i });
      await expect(airDatesBtn).toBeVisible();
      await airDatesBtn.click();
    } else {
      const datesLink = songsCard.locator('.m-card').filter({ hasText: 'Handsome John' }).first()
        .getByRole('button', { name: /Dates/i })
        .or(songsCard.locator('.m-card').filter({ hasText: 'Handsome John' }).first().getByRole('link', { name: /Dates/i }));
      await expect(datesLink).toBeVisible();
      expect((await datesLink.boundingBox()).height).toBeGreaterThanOrEqual(44);
      await datesLink.click();
    }

    await expect(page).toHaveURL(/\/episodes\?song=Handsome(%20|\+)John&artist=Todd(%20|\+)Snider/);
  });
});
