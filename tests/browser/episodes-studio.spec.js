// End-to-end Playwright specs for Variant A Studio Log (/episodes) on desktop (1440x900) and mobile (375x812).
import { expect, test } from '@playwright/test';
import { EXPECTED } from './snapshot-expected.js';

const YT_MOCK_SCRIPT = `(() => {
  window.__ytCalls = [];
  class MockYTPlayer {
    constructor(target, opts = {}) {
      this._events = opts.events || {};
      this._videoId = opts.videoId || '';
      const iframe = document.createElement('iframe');
      iframe.src = 'about:blank';
      target?.parentNode?.replaceChild(iframe, target);
      this._iframe = iframe;
      window.__ytCalls.push({ op: 'init', videoId: this._videoId });
      setTimeout(() => this._events.onReady?.({ target: this }), 0);
    }
    getIframe() { return this._iframe; }
    cueVideoById(id) { this._videoId = id; window.__ytCalls.push({ op: 'cue', videoId: id }); setTimeout(() => this._events.onStateChange?.({ data: 5, target: this }), 0); }
    loadVideoById(id) { this._videoId = id; window.__ytCalls.push({ op: 'load', videoId: id }); setTimeout(() => this._events.onStateChange?.({ data: 1, target: this }), 0); }
    playVideo() { setTimeout(() => this._events.onStateChange?.({ data: 1, target: this }), 0); }
    destroy() { window.__ytCalls.push({ op: 'destroy', videoId: this._videoId }); }
  }
  window.YT = { Player: MockYTPlayer, PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } };
  if (typeof window.onYouTubeIframeAPIReady === 'function') window.onYouTubeIframeAPIReady();
})();`;

function trackRuntimeErrors(page) {
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => pageErrors.push(err.message));
  return { consoleErrors, pageErrors };
}

async function stubYouTubeIframe(page) {
  await page.route('https://www.youtube.com/iframe_api', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body: YT_MOCK_SCRIPT }),
  );
}

async function assertNoOverflow(page) {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(m.sw).toBeLessThanOrEqual(m.iw);
}

async function assertOverflowAtViewports(page, viewports) {
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height });
    await assertNoOverflow(page);
  }
  await page.setViewportSize({ width: 375, height: 812 });
}

async function assertTapMin(loc, min = 44) {
  const box = await loc.boundingBox();
  expect(box).not.toBeNull();
  expect(box.width).toBeGreaterThanOrEqual(min);
  expect(box.height).toBeGreaterThanOrEqual(min);
}

async function assertAdjacentGap(containerLoc, itemSelector, minGap = 8) {
  const rects = await containerLoc.locator(itemSelector).evaluateAll((els) =>
    els.map((el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; })
      .filter((r) => r.width > 0 && r.height > 0),
  );
  expect(rects.length).toBeGreaterThan(1);
  for (let i = 0; i < rects.length - 1; i += 1) {
    const [a, b] = [rects[i], rects[i + 1]];
    const sameRow = Math.abs(a.top - b.top) < Math.min(a.height, b.height) * 0.75;
    expect(sameRow ? b.left - a.right : b.top - a.bottom).toBeGreaterThanOrEqual(minGap - 0.25);
  }
}

test.describe('Episodes Studio Log (Variant A)', () => {
  test('desktop: filter bar search/year/day/random, collapsible rail, and wheel scroll preservation', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Desktop Studio Log filter & rail spec');
    const { consoleErrors, pageErrors } = trackRuntimeErrors(page);
    await stubYouTubeIframe(page);
    await page.goto('/episodes');

    const filterBar = page.locator('.episodes-filter-bar');
    await expect(filterBar).toBeVisible();
    await expect(filterBar.locator('.year-select')).toHaveCount(1);

    const dayGroup = filterBar.getByRole('group', { name: 'Filter by broadcast day' });
    await expect(dayGroup.getByRole('button', { name: 'All Days' })).toHaveAttribute('aria-pressed', 'true');
    const randomBtn = filterBar.getByRole('button', { name: 'Random' });
    await expect(randomBtn).toBeEnabled();

    const searchInput = page.locator('#episode-search-input');
    await searchInput.fill(EXPECTED.latestFirstTrack.songTitle);
    await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe(EXPECTED.latestFirstTrack.songTitle);
    const clearSearchBtn = filterBar.getByRole('button', { name: 'Clear episode search' });
    await expect(clearSearchBtn).toBeVisible();
    await clearSearchBtn.click();
    await expect(searchInput).toHaveValue('');
    await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBeNull();

    await dayGroup.getByRole('button', { name: 'Sat' }).click();
    await expect(page).toHaveURL(/day=Saturday/);
    await expect(dayGroup.getByRole('button', { name: 'Sat' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.airdate-rail .airdate-dow').first()).toHaveText('SAT');
    await expect(page.locator('.broadcast-log .playlist-pane')).toContainText('Saturday');
    await dayGroup.getByRole('button', { name: 'All Days' }).click();
    await expect(page).not.toHaveURL(/day=/);

    const beforeRandom = new URL(page.url()).searchParams.get('episode');
    await randomBtn.click();
    await expect.poll(() => new URL(page.url()).searchParams.get('episode')).not.toBe(beforeRandom);

    await page.goto('/episodes');
    const rail = page.locator('.airdate-rail');
    const playlistPane = page.locator('.broadcast-log .playlist-pane');
    await expect(rail).toBeVisible();
    const initialRailBox = await rail.boundingBox();
    const initialPlaylistBox = await playlistPane.boundingBox();
    expect(initialRailBox.width).toBeGreaterThanOrEqual(276);
    expect(initialRailBox.width).toBeLessThanOrEqual(312);

    await page.getByRole('button', { name: 'Collapse air dates' }).click();
    await expect(page).toHaveURL(/rail=collapsed/);
    await expect(rail).toHaveClass(/is-collapsed/);
    const collapsedRailBox = await rail.boundingBox();
    const expandedPlaylistBox = await playlistPane.boundingBox();
    expect(collapsedRailBox.width).toBeLessThanOrEqual(164);
    expect(expandedPlaylistBox.width - initialPlaylistBox.width).toBeGreaterThan(130);

    const airdateScroll = page.locator('.airdate-scroll');
    const scrollBox = await airdateScroll.boundingBox();
    await page.mouse.move(scrollBox.x + scrollBox.width / 2, scrollBox.y + scrollBox.height / 2);
    await page.mouse.wheel(0, 220);
    await expect.poll(() => airdateScroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
    const scrollBefore = await airdateScroll.evaluate((el) => el.scrollTop);

    const visibleIdx = await airdateScroll.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const rows = [...el.querySelectorAll('.airdate-row')];
      return rows.findIndex((r, idx) => {
        if (idx === 0) return false;
        const rb = r.getBoundingClientRect();
        return rb.top >= box.top + 8 && rb.bottom <= box.bottom - 8;
      });
    });
    expect(visibleIdx).toBeGreaterThan(0);
    const prevEp = new URL(page.url()).searchParams.get('episode');
    await airdateScroll.locator('.airdate-row').nth(visibleIdx).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('episode')).not.toBe(prevEp);
    expect(await airdateScroll.evaluate((el) => el.scrollTop)).toBe(scrollBefore);

    await page.getByRole('button', { name: 'Expand air dates' }).click();
    await expect(page).not.toHaveURL(/rail=/);
    await expect(rail).not.toHaveClass(/is-collapsed/);
    expect((await rail.boundingBox()).width).toBeGreaterThanOrEqual(276);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test('desktop: DNA strip, key filter pills, dot badges, steppers, copy, audition deck, and themes', async ({ page, context }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Desktop Studio Log DNA & deck spec');
    const { consoleErrors, pageErrors } = trackRuntimeErrors(page);
    await stubYouTubeIframe(page);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/episodes');

    const dnaStrip = page.locator('.dna-strip');
    await expect(dnaStrip).toBeVisible();
    await expect(dnaStrip.locator('.dna-label')).toHaveText(['Spins', 'Song Debuts', 'Artist Debuts', 'Only Spin (1x)', '5+ Staples']);

    const keyGroup = page.getByRole('group', { name: 'Filter playlist by archive key' });
    const rows = page.locator('.playlist-table tbody tr');
    await expect(keyGroup.getByRole('button', { name: /^All\b/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(rows).toHaveCount(EXPECTED.latestSongCount);

    for (const [label, badgeSelector] of [
      ['Song Debut', '.dot-badge--d'],
      ['Only Spin', '.dot-badge--o'],
      ['5+ Staple', '.dot-badge--s'],
      ['Playable', '.audition-play-btn'],
    ]) {
      const pill = keyGroup.getByRole('button', { name: new RegExp(`^${label.replace('+', '\\+')}`) });
      if (await pill.isEnabled()) {
        const expectedCount = Number(await pill.locator('.key-pill-count').innerText());
        await pill.click();
        await expect(pill).toHaveAttribute('aria-pressed', 'true');
        await expect(rows).toHaveCount(expectedCount);
        await expect(rows.first().locator(badgeSelector)).toBeVisible();
        await pill.click();
        await expect(keyGroup.getByRole('button', { name: /^All\b/ })).toHaveAttribute('aria-pressed', 'true');
        await expect(rows).toHaveCount(EXPECTED.latestSongCount);
      }
    }

    const dotBadge = page.locator('.playlist-table td.col-history .dot-badge').first();
    await expect(dotBadge).toBeVisible();
    const dotMetrics = await dotBadge.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return { w: Math.round(r.width), h: Math.round(r.height), radius: s.borderRadius, text: el.textContent?.trim() };
    });
    expect(dotMetrics.w).toBe(20);
    expect(dotMetrics.h).toBe(20);
    expect(dotMetrics.radius === '50%' || parseFloat(dotMetrics.radius) >= 10).toBe(true);
    expect(['D', 'A', 'O', 'S']).toContain(dotMetrics.text);
    await expect(page.locator('.playlist-table td.col-history [role="progressbar"], .playlist-table td.col-history .meter-bar')).toHaveCount(0);

    const newerBtn = page.getByRole('button', { name: 'Newer episode' });
    const olderBtn = page.getByRole('button', { name: 'Older episode' });
    await expect(newerBtn).toBeDisabled();
    await expect(olderBtn).toBeEnabled();
    await olderBtn.click();
    await expect.poll(() => new URL(page.url()).searchParams.get('episode')).not.toBe(EXPECTED.latestEpisodeId);
    await expect(newerBtn).toBeEnabled();
    await newerBtn.click();
    await expect.poll(() => new URL(page.url()).searchParams.get('episode')).toBe(EXPECTED.latestEpisodeId);

    await page.getByRole('button', { name: /^Copy$/ }).click();
    await expect(page.getByRole('button', { name: /^Copied$/ })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(EXPECTED.latestFirstTrack.songTitle);

    await page.getByRole('button', { name: /Play Matched/i }).click();
    const deck = page.locator('.audition-deck');
    await expect(deck).toBeVisible();
    await expect(deck).toContainText(/^.*1\/\d+ playable/);
    await deck.getByRole('button', { name: 'Skip spin' }).click();
    await expect(deck).toContainText(/2\/\d+ playable/);
    await deck.getByRole('button', { name: 'Close deck' }).click();
    await expect(deck).toBeHidden();

    await page.locator('.playlist-table .audition-play-btn').nth(1).click();
    await expect(deck).toBeVisible();
    await expect(deck).toContainText(/2\/\d+ playable/);
    await deck.getByRole('button', { name: 'Close deck' }).click();

    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(244, 244, 246)');
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test('mobile: 320/375/430 0px overflow (list, banner, detail), >=44px targets, >=8px gaps, labels, and themes', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-375', 'Mobile Studio Log spec');
    const viewports = [[320, 667], [375, 812], [430, 932]];
    const { consoleErrors, pageErrors } = trackRuntimeErrors(page);
    await stubYouTubeIframe(page);
    await page.goto('/episodes');

    await expect(page.locator('.episodes-filter-bar')).toBeVisible();
    await expect(page.locator('.m-card').first()).toBeVisible();
    const searchInput = page.locator('#episode-search-input');
    expect(await searchInput.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);

    await searchInput.fill(EXPECTED.latestFirstTrack.songTitle);
    const clearBtn = page.locator('.search-clear-icon-btn');
    await expect(clearBtn).toBeVisible();
    await assertTapMin(clearBtn);
    await clearBtn.click();
    await expect(searchInput).toHaveValue('');
    await expect(page.locator('.m-card').first()).toBeVisible();

    for (const sel of ['#episode-search-input', '.year-select', '.day-seg-btn', '.episodes-random-btn']) {
      await assertTapMin(page.locator(sel).first());
    }
    await assertAdjacentGap(page.locator('.day-segmented'), '.day-seg-btn');
    await assertOverflowAtViewports(page, viewports);

    await page.locator('.m-card').first().click();
    await expect(page).toHaveURL(/episode=/);
    await expect(page.locator('.dna-strip')).toBeVisible();
    expect(await page.locator('.push-detail-bar').evaluate((el) => getComputedStyle(el).position)).not.toBe('sticky');

    await assertTapMin(page.getByRole('button', { name: 'Back', exact: true }));
    await assertTapMin(page.locator('.key-pill').first());
    await assertTapMin(page.locator('.playlist-step-group button').nth(0));
    await assertTapMin(page.locator('.playlist-step-group button').nth(1));
    await assertTapMin(page.getByRole('button', { name: /^Copy$/ }));
    const ytBtn = page.locator('.playlist-actions a.btn');
    if (await ytBtn.count()) {
      await assertTapMin(ytBtn);
      expect(await ytBtn.evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe('none');
    }
    await assertTapMin(page.getByRole('button', { name: /Play Matched/i }));
    await assertTapMin(page.locator('.playlist-mobile-row .playlist-song-btn').first());
    await assertTapMin(page.locator('.playlist-mobile-row .playlist-artist-wrap .cell-link-btn').first());

    for (const lbl of await page.locator('.playlist-step-group .step-btn-label').all()) await expect(lbl).toBeVisible();
    expect(await page.locator('.playlist-step-group .tooltip-bubble').first().evaluate((el) => getComputedStyle(el).display)).toBe('none');
    await assertAdjacentGap(page.locator('.playlist-step-group'), 'button');
    await assertAdjacentGap(page.locator('.episode-key-bar'), '.key-pill');

    const mobilePlayBtn = page.locator('.playlist-mobile-row .audition-play-btn').first();
    await expect(mobilePlayBtn).toBeVisible();
    await expect(mobilePlayBtn.locator('.audition-play-label')).toBeVisible();
    await assertTapMin(mobilePlayBtn);
    await mobilePlayBtn.click();

    const deck = page.locator('.audition-deck');
    await expect(deck).toBeVisible();
    for (const btn of await deck.locator('.audition-dock-btn').all()) await assertTapMin(btn);
    for (const lbl of await deck.locator('.audition-dock-label').all()) await expect(lbl).toBeVisible();
    expect(await deck.locator('.audition-dock .tooltip-bubble').first().evaluate((el) => getComputedStyle(el).display)).toBe('none');
    await assertAdjacentGap(deck.locator('.audition-dock'), '.audition-dock-btn');
    await assertOverflowAtViewports(page, viewports);

    await page.locator('.playlist-mobile-row .playlist-song-btn').first().click();
    await expect(page.locator('.filter-banner')).toBeVisible();
    await assertOverflowAtViewports(page, viewports);

    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
    await assertNoOverflow(page);
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
