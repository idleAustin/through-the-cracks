// End-to-end Playwright specs for Ticket 04 paginated Artists & Songs catalogs and inline/push ArtistInspector.
import { expect, test } from '@playwright/test';

test.describe('Paginated catalogs and inline/push ArtistInspector', () => {
  test('paginates full 1,891 artists and 16,782 songs with global rank, cap, debounced ?q=, and URL history', async ({ page }, testInfo) => {
    const isMobile = testInfo.project.name === 'mobile-375';
    await page.goto('/artists');

    await expect(page.getByRole('heading', { name: 'Artists', level: 1 })).toBeVisible();
    await expect(page.locator('main')).toContainText(/1[–-]25 of 1,891/);
    const artistItems = isMobile ? page.locator('.m-card-stack .m-card') : page.locator('#artists-table tbody tr');
    await expect(artistItems).toHaveCount(25);

    await page.getByRole('button', { name: /Next/i }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page.locator('main')).toContainText(/26[–-]50 of 1,891/);
    await expect(artistItems.first()).toContainText('26');
    await expect(artistItems.last()).toContainText('50');

    await page.goBack();
    await expect(page).not.toHaveURL(/page=2/);

    await page.getByRole('button', { name: 'Top 10', exact: true }).click();
    await expect(page).toHaveURL(/cap=10/);
    await expect(artistItems).toHaveCount(10);
    await page.goBack();
    await expect(page).not.toHaveURL(/cap=10/);

    await page.getByRole('searchbox', { name: 'Search artists' }).fill('Lucinda');
    await expect(page).toHaveURL(/q=Lucinda/);
    await expect(page.locator('#artists-table:visible, .m-card-stack:visible')).toContainText('Lucinda Williams');

    await page.goto('/songs');
    await expect(page.getByRole('heading', { name: 'Songs', level: 1 })).toBeVisible();
    await expect(page.locator('main')).toContainText(/1[–-]25 of 16,782/);
    const songItems = isMobile ? page.locator('.m-card-stack .m-card') : page.locator('#songs-table tbody tr');
    await expect(songItems).toHaveCount(25);
  });

  test('toggles Most Obscure ordering on /artists and /songs', async ({ page }, testInfo) => {
    const isMobile = testInfo.project.name === 'mobile-375';

    await page.goto('/artists');
    await page.getByRole('button', { name: 'Most Obscure' }).click();
    await expect(page).toHaveURL(/sort=obscure/);
    const firstArtist = (isMobile ? page.locator('.m-card-stack .m-card') : page.locator('#artists-table tbody tr')).first();
    await expect(firstArtist).toContainText(/\b1\b/);

    await page.goto('/songs');
    await page.getByRole('button', { name: 'Most Obscure' }).click();
    await expect(page).toHaveURL(/sort=obscure/);
    const firstSong = (isMobile ? page.locator('.m-card-stack .m-card') : page.locator('#songs-table tbody tr')).first();
    await expect(firstSong).toContainText(/\b1\b/);
  });

  test('opens ArtistInspector inline at 1440px and as Full-Screen Push View at 375px with album filter & Song routing', async ({ page }, testInfo) => {
    const isMobile = testInfo.project.name === 'mobile-375';
    await page.goto('/artists?page=2&sort=top');

    const page2First = isMobile
      ? page.locator('.m-card-stack .m-card').first()
      : page.locator('#artists-table tbody tr').first();
    await page2First.click();
    await expect(page).toHaveURL(/artist=/);
    await page.keyboard.press('Escape');
    await expect(page).not.toHaveURL(/artist=/);
    await expect(page).toHaveURL(/page=2/);

    await page.goto('/artists');
    const toddRow = isMobile
      ? page.locator('.m-card-stack .m-card').filter({ hasText: 'Todd Snider' }).first()
      : page.locator('#artists-table tbody tr').filter({ hasText: 'Todd Snider' }).first();
    await toddRow.click();

    await expect(page).toHaveURL(/artist=Todd(%20|\+)Snider/);
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const inspector = isMobile ? page.locator('.push-view') : page.locator('.inline-inspector');
    await expect(inspector).toBeVisible();

    if (!isMobile) {
      await expect(page.locator('#artists-table')).toBeVisible();
      const box = await inspector.boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(360);
      expect(box.width).toBeLessThanOrEqual(440);
    } else {
      const backBtn = page.getByRole('button', { name: 'Back', exact: true });
      await expect(backBtn).toBeVisible();
      expect((await backBtn.boundingBox()).height).toBeGreaterThanOrEqual(44);
    }

    await expect(inspector).toContainText('Spins');
    await expect(inspector).toContainText('Songs');
    await expect(inspector).toContainText('Albums');
    await expect(inspector).toContainText('First Spin');
    await expect(inspector).toContainText('Last Spin');

    const albumSelect = inspector.locator('select');
    await expect(albumSelect).toBeVisible();
    if (isMobile) {
      expect((await albumSelect.boundingBox()).height).toBeGreaterThanOrEqual(44);
      const fontSize = await albumSelect.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      expect(fontSize).toBeGreaterThanOrEqual(16);
    }
    const albumValue = await albumSelect.locator('option').nth(1).getAttribute('value');
    await albumSelect.selectOption(albumValue);
    await expect(page).toHaveURL(/album=/);

    await albumSelect.selectOption('');
    await inspector.getByText('Handsome John').first().click();
    await expect(page).toHaveURL(/\/episodes\?song=Handsome(%20|\+)John&artist=Todd(%20|\+)Snider/);
  });

  test('routes Song clicks to /episodes and Artist button clicks inside /songs to inline/push inspector', async ({ page }, testInfo) => {
    const isMobile = testInfo.project.name === 'mobile-375';
    await page.goto('/songs');

    const artistBtn = isMobile
      ? page.locator('.m-card-stack .m-card').first().getByRole('button', { name: 'Carrie Rodriguez' })
      : page.locator('#songs-table tbody tr').first().getByRole('button', { name: 'Carrie Rodriguez' });
    await artistBtn.click();

    expect(await page.evaluate(() => window.location.pathname)).toBe('/songs');
    await expect(page).toHaveURL(/artist=Carrie(%20|\+)Rodriguez/);
    await expect(page.getByRole('dialog')).toHaveCount(0);

    if (isMobile) {
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
      await page.getByRole('button', { name: 'Back', exact: true }).click();
    } else {
      await page.keyboard.press('Escape');
    }

    const songRow = isMobile
      ? page.locator('.m-card-stack .m-card').first()
      : page.locator('#songs-table tbody tr').first();
    await songRow.click();
    await expect(page).toHaveURL(/\/episodes\?song=50s(%20|\+)French(%20|\+)Movie&artist=Carrie(%20|\+)Rodriguez/);
    await expect(page.getByText('Played Song')).toBeVisible();
  });
});
