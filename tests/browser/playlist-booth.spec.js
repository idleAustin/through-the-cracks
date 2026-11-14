// End-to-end Playwright specs for /playlist Broadcast Booth filters, swaps, exports, status states, themes, and responsive layout.
import { expect, test } from '@playwright/test';

const YT_DOUBLE_SCRIPT = `(() => {
  const t = { constructors: [], calls: [], manualPlayback: false, player: null };
  t.emitState = (c) => t.player?._events?.onStateChange?.({ data: c, target: t.player });
  t.emitError = (c) => t.player?._events?.onError?.({ data: c, target: t.player });
  window.__ytTest = t;
  class MockYTPlayer {
    constructor(target, opts = {}) {
      this._events = opts.events || {};
      this._videoId = opts.videoId || '';
      const iframe = document.createElement('iframe');
      iframe.src = 'about:blank';
      target?.parentNode?.replaceChild(iframe, target);
      this._iframe = iframe;
      t.player = this;
      t.constructors.push({ videoId: this._videoId, autoplay: Boolean(opts.playerVars?.autoplay) });
      setTimeout(() => this._events.onReady?.({ target: this }), 0);
    }
    getIframe() { return this._iframe; }
    cueVideoById(id) { this._videoId = id; t.calls.push({ method: 'cueVideoById', videoId: id }); setTimeout(() => this._events.onStateChange?.({ data: 5, target: this }), 0); }
    loadVideoById(id) { this._videoId = id; t.calls.push({ method: 'loadVideoById', videoId: id }); setTimeout(() => { this._events.onStateChange?.({ data: 3, target: this }); if (!t.manualPlayback) setTimeout(() => this._events.onStateChange?.({ data: 1, target: this }), 15); }, 0); }
    playVideo() { t.calls.push({ method: 'playVideo', videoId: this._videoId }); if (!t.manualPlayback) setTimeout(() => this._events.onStateChange?.({ data: 1, target: this }), 0); }
    destroy() { t.calls.push({ method: 'destroy', videoId: this._videoId }); }
  }
  window.YT = { Player: MockYTPlayer, PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } };
  if (typeof window.onYouTubeIframeAPIReady === 'function') window.onYouTubeIframeAPIReady();
})();`;

const toSong = ([id, artist, title, album, plays, score, dur]) => ({
  songKey: `${artist.toLowerCase()}|||${title.toLowerCase()}`,
  artist, songTitle: title, album, totalPlays: plays, videoId: id,
  ytTitle: title, ytArtist: artist, durationSeconds: dur, confidenceScore: score,
  matchTier: score >= 85 ? 'high' : 'medium',
});

const POOL = [
  ['aYdxQ05nOSo', 'The Toy Trucks', 'Schoolbus', 'Rockets, Bells And Poetry', 9, 100, 257],
  ['vid-csn-01', 'Crosby, Stills & Nash', 'Suite: Judy Blue Eyes', 'Crosby, Stills & Nash', 5, 96, 448],
  ['vid-am-01', 'Allison Moorer', 'The Rock And The Hill', 'Blood', 7, 90, 220],
  ['vid-ej-01', 'Eilen Jewell', 'Witness', 'Gypsy', 7, 100, 173],
  ['vid-ll-01', 'Los Lobos', 'Down On The Riverbed', 'The Neighborhood', 6, 100, 246],
  ['vid-rb-01', 'Randall Bramblett', 'Roll', 'The Bright Spots', 6, 100, 202],
  ['vid-ts-01', 'Todd Snider', 'Alright Guy', 'Songs for the Daily Planet', 8, 99, 212],
  ['vid-jp-01', 'John Prine', 'Sam Stone', 'John Prine', 6, 98, 255],
  ['vid-lw-01', 'Lucinda Williams', 'Car Wheels', 'Car Wheels on a Gravel Road', 5, 97, 284],
  ['vid-bd-01', 'Bob Dylan', 'Mississippi', 'Love and Theft', 4, 95, 321],
  ['vid-fav-11', 'Gillian Welch', 'Look at Miss Ohio', 'Soul Journey', 4, 94, 256],
  ...Array.from({ length: 11 }, (_, i) => [`vid-dc-${i + 1}`, `Deep Artist ${i + 1}`, `Deep Cut ${i + 1}`, `Deep LP ${i + 1}`, (i % 2) + 1, 91, 180 + i]),
  ['vid-med-01', 'Townes Van Zandt', 'Pancho and Lefty', 'The Late Great', 5, 72, 218], ['vid-med-02', 'Guy Clark', 'L.A. Freeway', 'Old No. 1', 4, 70, 260],
  ['vid-med-03', 'Blaze Foley', 'Clay Pigeons', 'Live at the Austin Outhouse', 1, 68, 210], ['vid-med-04', 'Steve Earle', 'Copperhead Road', 'Copperhead Road', 2, 74, 269],
].map(toSong);

async function setupBooth(page) {
  const errors = { console: [], page: [] };
  page.on('console', (m) => { if (m.type() === 'error') errors.console.push(m.text()); });
  page.on('pageerror', (e) => errors.page.push(e.message));
  const state = {
    requests: [], drawCount: 0, swapOffset: 0,
    inFlightSwaps: 0, maxConcurrentSwaps: 0, holdSwaps: false, swapReleases: [],
    delayMs: 0, failRandom: false, failStatic: false, emptyWhenMode: '', singleSongMode: false,
  };

  await page.route('https://www.youtube.com/iframe_api', (r) => r.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body: YT_DOUBLE_SCRIPT }));
  await page.route('**/data/song-links.json', (r) => {
    if (!state.failStatic) return r.continue();
    state.failStatic = false;
    return r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"static down"}' });
  });
  await page.route('**/api/playlist/random*', async (route) => {
    const url = new URL(route.request().url());
    const count = Number(url.searchParams.get('count') || 10);
    const mode = url.searchParams.get('mode') || 'all';
    const minScore = Number(url.searchParams.get('minScore') || 85);
    const onePerArtist = url.searchParams.get('onePerArtist') !== 'false';
    const exclude = new Set((url.searchParams.get('exclude') || '').split(',').filter(Boolean));
    const excludeArtist = url.searchParams.getAll('excludeArtist');
    const excludeArtistSet = new Set(excludeArtist.map((a) => a.trim().toLowerCase()));
    state.requests.push({ count, mode, minScore, onePerArtist, exclude: [...exclude], excludeArtist });

    let swapStep = 0;
    if (count === 1) {
      swapStep = state.swapOffset++;
      state.inFlightSwaps += 1;
      state.maxConcurrentSwaps = Math.max(state.maxConcurrentSwaps, state.inFlightSwaps);
      if (state.holdSwaps) await new Promise((resolve) => state.swapReleases.push(resolve));
      state.inFlightSwaps -= 1;
    } else if (state.delayMs > 0) {
      await new Promise((r) => setTimeout(r, state.delayMs));
    }

    if (state.failRandom) {
      state.failRandom = false;
      return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' });
    }
    if (state.emptyWhenMode && mode === state.emptyWhenMode) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, poolSize: 0, minScore, mode, onePerArtist, songs: [] }) });
    }

    const eligible = POOL.filter((s) => s.confidenceScore >= minScore && (mode !== 'favorites' || s.totalPlays >= 3) && (mode !== 'deep_cuts' || (s.totalPlays >= 1 && s.totalPlays <= 2)));
    let songs = [];
    if (count === 1) {
      const avail = eligible.filter((s) => !exclude.has(s.videoId) && !excludeArtistSet.has(s.artist.toLowerCase()));
      if (avail.length > 0) songs = [avail[swapStep % avail.length]];
    } else {
      state.drawCount += 1;
      const offset = state.drawCount <= 2 ? 0 : state.drawCount - 2;
      const rotated = eligible.slice(offset % eligible.length).concat(eligible.slice(0, offset % eligible.length));
      const avail = rotated.filter((s) => !exclude.has(s.videoId) && !excludeArtistSet.has(s.artist.toLowerCase()));
      songs = avail.slice(0, state.singleSongMode ? 1 : count);
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ count: songs.length, poolSize: state.singleSongMode ? 1 : eligible.length, minScore, mode, onePerArtist, songs }),
    });
  });

  return { state, errors };
}

const expectNoOverflow = async (page) => {
  const m = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(m.w).toBeLessThanOrEqual(m.iw);
};
const expectNoErrors = (errors, allow503 = false) => {
  expect(allow503 ? errors.console.filter((m) => !m.includes('503 (Service Unavailable)')) : errors.console).toEqual([]);
  expect(errors.page).toEqual([]);
};

test.describe('Broadcast Booth Ticket 02 (/playlist)', () => {
  test('desktop 1440 & narrow 1025: filters, URL persistence, Roll 10, light/dark themes, and stacking', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Desktop viewport spec');
    const { state, errors } = await setupBooth(page);
    const rowSongs = page.locator('.booth-table tbody .booth-song-btn');

    await page.goto('/playlist');
    await expect(rowSongs).toHaveCount(10);
    await expect(page.locator('.booth-pool-pill .num')).toHaveText('22');
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--as-bg-base').trim())).toBe('#0a0a0c');

    const favBtn = page.getByRole('button', { name: '3+ Spins' });
    const deepBtn = page.getByRole('button', { name: '1–2 Spins' });
    const scoreSelect = page.getByLabel('Confidence threshold');
    const artistToggle = page.getByRole('button', { name: '1 per artist' });
    await expect(page.getByRole('button', { name: 'All Spins' })).toHaveAttribute('aria-pressed', 'true');
    await expect(scoreSelect).toHaveValue('85');
    await expect(artistToggle).toHaveAttribute('aria-pressed', 'true');

    await favBtn.click();
    await expect(page).toHaveURL('/playlist?mode=favorites');
    await expect(page.locator('.booth-pool-pill .num')).toHaveText('11');

    await deepBtn.click();
    await expect(page).toHaveURL('/playlist?mode=deep_cuts');
    await expect(page.locator('.booth-pool-pill .num')).toHaveText('11');

    await scoreSelect.selectOption('65');
    await expect(page).toHaveURL('/playlist?mode=deep_cuts&minScore=65');
    await expect(page.locator('.booth-pool-pill .num')).toHaveText('13');

    await artistToggle.click();
    await expect(page).toHaveURL('/playlist?mode=deep_cuts&minScore=65&onePerArtist=false');
    await expect(artistToggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.booth-cockpit')).not.toHaveAttribute('aria-busy', 'true');
    const beforeReload = await rowSongs.allTextContents();

    await page.reload();
    await expect(page).toHaveURL('/playlist?mode=deep_cuts&minScore=65&onePerArtist=false');
    await expect(deepBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(scoreSelect).toHaveValue('65');
    await expect(artistToggle).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => rowSongs.allTextContents()).not.toEqual(beforeReload);
    const afterReload = await rowSongs.allTextContents();

    await page.getByRole('button', { name: 'Roll 10' }).click();
    await expect(rowSongs).toHaveCount(10);
    await expect.poll(() => rowSongs.allTextContents()).not.toEqual(afterReload);
    expect(state.requests.at(-1)).toMatchObject({ mode: 'deep_cuts', minScore: 65, onePerArtist: false });

    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--as-bg-base').trim())).toBe('#f4f4f6');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--as-accent-fg').trim())).toBe('#3f6212');
    await expectNoOverflow(page);

    await page.setViewportSize({ width: 1025, height: 900 });
    const narrow = await page.evaluate(() => {
      const deck = document.querySelector('.booth-deck').getBoundingClientRect();
      const list = document.querySelector('.booth-playlist').getBoundingClientRect();
      const wrap = document.querySelector('.booth-playlist .table-container');
      return { stacked: list.top >= deck.bottom - 1, tableOverflow: wrap.scrollWidth > wrap.clientWidth + 1 };
    });
    expect(narrow.stacked).toBe(true);
    expect(narrow.tableOverflow).toBe(false);
    await expectNoOverflow(page);
    expectNoErrors(errors);
  });

  test('desktop: concurrent row swaps, deck swap, comma-safe excludeArtist, exports, dock, and route links', async ({ page, context }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Desktop viewport spec');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const { state, errors } = await setupBooth(page);
    const rowSongs = page.locator('.booth-table tbody .booth-song-btn');

    await page.goto('/playlist');
    await expect(rowSongs).toHaveCount(10);
    const initialSongs = await rowSongs.allTextContents();

    state.holdSwaps = true;
    const swapBtn1 = page.locator('.booth-table tbody tr').nth(1).locator('.booth-table-swap-btn');
    const swapBtn2 = page.locator('.booth-table tbody tr').nth(2).locator('.booth-table-swap-btn');
    await swapBtn1.click();
    await swapBtn2.click();
    await expect(swapBtn1).toBeDisabled();
    await expect(swapBtn2).toBeDisabled();
    await expect.poll(() => state.swapReleases.length).toBe(2);
    state.holdSwaps = false;
    state.swapReleases.splice(0).forEach((release) => release());
    await expect(swapBtn1).toBeEnabled();
    await expect(swapBtn2).toBeEnabled();

    expect(state.maxConcurrentSwaps).toBeGreaterThanOrEqual(2);
    const swapReqs = state.requests.filter((r) => r.count === 1);
    expect(swapReqs).toHaveLength(2);
    expect(swapReqs[0].excludeArtist).toContain('Crosby, Stills & Nash');
    expect(swapReqs[1].excludeArtist).toContain('Crosby, Stills & Nash');
    expect(swapReqs[0].exclude.length).toBeLessThanOrEqual(25);

    const afterRowSwaps = await rowSongs.allTextContents();
    expect(afterRowSwaps[1]).not.toBe(initialSongs[1]);
    expect(afterRowSwaps[2]).not.toBe(initialSongs[2]);
    for (const idx of [0, 3, 4, 5, 6, 7, 8, 9]) expect(afterRowSwaps[idx]).toBe(initialSongs[idx]);

    await page.getByRole('button', { name: 'Swap song' }).click();
    await expect(page.getByRole('button', { name: 'Swap song' })).toBeEnabled();
    const afterDeckSwap = await rowSongs.allTextContents();
    expect(afterDeckSwap[0]).not.toBe(afterRowSwaps[0]);
    for (let i = 1; i < 10; i += 1) expect(afterDeckSwap[i]).toBe(afterRowSwaps[i]);

    expect(await page.getByRole('link', { name: 'Open 10 on YouTube' }).getAttribute('href')).toMatch(/^https:\/\/www\.youtube\.com\/watch_videos\?video_ids=([^,]+,){9}[^,]+$/);
    await page.getByRole('button', { name: 'Copy Playlist' }).click();
    await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
    const copiedText = await page.evaluate(() => navigator.clipboard.readText());
    const expectedText = await page.evaluate(() =>
      [...document.querySelectorAll('.booth-table tbody tr')].map((tr, i) => `${i + 1}. ${tr.children[2].textContent.trim()} — ${tr.querySelector('.booth-song-btn').textContent.trim()}`).join('\n'),
    );
    expect(copiedText).toBe(expectedText);

    await expect(page.locator('.booth-dock .booth-dock-label').first()).toBeHidden();
    const slot0Artist = await page.locator('.booth-artist-link').textContent();
    const slot0Song = await page.locator('.booth-song-title').textContent();
    await expect(page.getByRole('link', { name: 'Open in YT Music' })).toHaveAttribute('href', /https:\/\/music\.youtube\.com\/watch\?v=/);

    await page.getByRole('button', { name: 'Next song' }).click();
    await expect(page.locator('.booth-deck .booth-region-title')).toContainText('02/10');
    await page.getByRole('button', { name: 'Previous song' }).click();
    await expect(page.locator('.booth-deck .booth-region-title')).toContainText('01/10');

    await page.getByRole('button', { name: 'Episode airings' }).click();
    await expect(page).toHaveURL((u) => u.pathname === '/episodes' && u.searchParams.get('song') === slot0Song && u.searchParams.get('artist') === slot0Artist);

    await page.goto('/playlist');
    const artistName = (await page.locator('.booth-artist-link').textContent()).trim();
    await page.locator('.booth-artist-link').click();
    await expect(page).toHaveURL((u) => u.pathname === '/artists' && u.searchParams.get('artist') === artistName);
    await expect(page.getByRole('heading', { name: artistName, level: 2 })).toBeVisible();
    expectNoErrors(errors);
  });

  test('desktop: deck status pills, Up next jump, onEnded auto-advance, and Blocked error 150 fallback', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Desktop viewport spec');
    const { state, errors } = await setupBooth(page);

    await page.goto('/playlist');
    await expect(page.locator('.booth-table tbody tr')).toHaveCount(10);
    await page.evaluate(() => { window.__ytTest.manualPlayback = true; });

    await expect(page.locator('.booth-deck .booth-region-title')).toContainText('01/10');
    await expect(page.locator('.booth-status-chip')).toHaveText('Cued');
    await expect(page.locator('.booth-provenance').first()).toContainText(/9 spins · 100\/100 · 4:17/);
    expect(await page.evaluate(() => document.querySelectorAll('.booth-upnext p, .booth-upnext div').length)).toBe(0);

    await page.locator('.booth-upnext').click();
    await expect(page.locator('.booth-deck .booth-region-title')).toContainText('02/10');
    await expect(page.locator('.booth-status-chip')).toHaveText('Buffering');

    await page.evaluate(() => window.__ytTest.emitState(1));
    await expect(page.locator('.booth-status-chip.is-playing')).toHaveText('Playing');
    await expect(page.locator('.booth-status-chip.is-playing .status-dot.is-live')).toBeVisible();

    await page.evaluate(() => window.__ytTest.emitState(2));
    await expect(page.locator('.booth-status-chip')).toHaveText('Paused');

    await page.locator('.booth-table tbody tr').nth(9).click();
    await expect(page.locator('.booth-deck .booth-region-title')).toContainText('10/10');
    await expect(page.locator('.booth-upnext')).toContainText('Up next · 01');
    await page.evaluate(() => window.__ytTest.emitState(0));
    await expect(page.locator('.booth-deck .booth-region-title')).toContainText('01/10');

    await page.evaluate(() => window.__ytTest.emitError(150));
    await expect(page.locator('.booth-status-chip.is-blocked')).toHaveText('Blocked');
    const blockedAlert = page.locator('.yt-deck-blocked[role="alert"]');
    await expect(blockedAlert).toBeVisible();
    await expect(blockedAlert.getByRole('link', { name: 'Open on YouTube' })).toHaveAttribute('href', 'https://www.youtube.com/watch?v=aYdxQ05nOSo');

    state.singleSongMode = true;
    await page.getByRole('button', { name: 'Roll 10' }).click();
    await expect(page.locator('.booth-deck .booth-region-title')).toContainText('01/01');
    await page.evaluate(() => window.__ytTest.emitState(0));
    await expect(page.locator('.booth-status-chip')).toHaveText('Ended');
    expectNoErrors(errors);
  });

  test('desktop: skeleton loading, Empty -> Clear Filters recovery, and Error -> Retry Roll recovery', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Desktop viewport spec');
    const { state, errors } = await setupBooth(page);
    state.delayMs = 250;
    state.emptyWhenMode = 'deep_cuts';

    await page.goto('/playlist');
    const skel = page.locator('[aria-busy="true"] .skeleton').first();
    await expect(skel).toBeVisible();
    expect(await skel.evaluate((el) => getComputedStyle(el).backgroundImage)).toBe('none');
    await expect(page.locator('.booth-table tbody tr')).toHaveCount(10);

    state.delayMs = 0;
    await page.getByRole('button', { name: '1–2 Spins' }).click();
    await expect(page.getByRole('heading', { name: 'No eligible Songs match those filters.' })).toBeVisible();
    await page.getByRole('button', { name: 'Clear Filters' }).click();
    await expect(page).toHaveURL('/playlist');
    await expect(page.locator('.booth-table tbody tr')).toHaveCount(10);

    state.failRandom = true;
    state.failStatic = true;
    await page.getByRole('button', { name: 'Roll 10' }).click();
    const alert = page.locator('.empty-state[role="alert"]');
    await expect(alert).toContainText('Playlist draw failed.');
    await alert.getByRole('button', { name: 'Retry Roll' }).click();
    await expect(page.locator('.booth-table tbody tr')).toHaveCount(10);
    expectNoErrors(errors, true);
  });

  test('mobile 375x812 & 320x667: touch targets, 16px select, visible dock labels, swaps, themes, and zero overflow', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-375', 'Mobile viewport spec');
    const { errors } = await setupBooth(page);

    await page.goto('/playlist');
    await expect(page.locator('.booth-mobile-row')).toHaveCount(10);
    await expectNoOverflow(page);
    expect(await page.locator('#playlist-min-score').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    for (const bubble of await page.locator('.booth-page .tooltip-bubble').all()) await expect(bubble).toBeHidden();

    const dockBtns = page.locator('.booth-dock .booth-dock-btn');
    await expect(dockBtns).toHaveCount(5);
    for (let i = 0; i < 5; i += 1) {
      await expect(dockBtns.nth(i).locator('.booth-dock-label')).toBeVisible();
      const box = await dockBtns.nth(i).boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    const swapBox = await page.locator('.booth-mobile-swap-btn').first().boundingBox();
    expect(swapBox.width).toBeGreaterThanOrEqual(44);
    expect(swapBox.height).toBeGreaterThanOrEqual(44);

    await page.evaluate(() => { window.__ytTest.manualPlayback = true; });
    await page.locator('.booth-upnext').click();
    await expect(page.locator('.booth-deck .booth-region-title')).toContainText('02/10');
    const beforeSwap = await page.locator('.booth-mobile-song').allTextContents();
    await page.locator('.booth-mobile-swap-btn').nth(1).click();
    await expect(page.locator('.booth-mobile-swap-btn').nth(1)).toBeEnabled();
    const afterSwap = await page.locator('.booth-mobile-song').allTextContents();
    expect(afterSwap[1]).not.toBe(beforeSwap[1]);
    expect(afterSwap[0]).toBe(beforeSwap[0]);

    await page.evaluate(() => window.__ytTest.emitError(150));
    await expect(page.locator('.yt-deck-blocked[role="alert"]')).toBeVisible();
    await page.locator('.mobile-theme-btn').click();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
    await expectNoOverflow(page);

    await page.setViewportSize({ width: 320, height: 667 });
    await page.goto('/playlist');
    await expect(page.locator('.booth-mobile-row')).toHaveCount(10);
    await expectNoOverflow(page);
    expect(await page.locator('#playlist-min-score').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    await expect(page.locator('.booth-dock .booth-dock-label').first()).toBeVisible();
    expectNoErrors(errors);
  });
});
