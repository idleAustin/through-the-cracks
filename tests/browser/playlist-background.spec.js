// End-to-end Playwright specs for persistent Broadcast Booth background playback, off-route mini-bar, 2-hour storage TTL, and mobile layout.
import { expect, test } from '@playwright/test';

const STORAGE_KEY = 'ttc:playlist-session:v1';

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
    pauseVideo() { t.calls.push({ method: 'pauseVideo', videoId: this._videoId }); if (!t.manualPlayback) setTimeout(() => this._events.onStateChange?.({ data: 2, target: this }), 0); }
    destroy() { t.calls.push({ method: 'destroy', videoId: this._videoId }); }
  }
  window.YT = { Player: MockYTPlayer, PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } };
  if (typeof window.onYouTubeIframeAPIReady === 'function') window.onYouTubeIframeAPIReady();
})();`;

const toSong = ([id, artist, title, album, plays, score, dur]) => ({
  songKey: `${artist.toLowerCase()}|||${title.toLowerCase()}`,
  artist,
  songTitle: title,
  album,
  totalPlays: plays,
  videoId: id,
  ytTitle: title,
  ytArtist: artist,
  durationSeconds: dur,
  confidenceScore: score,
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
].map(toSong);

async function setupBackgroundBooth(page) {
  const errors = { console: [], page: [] };
  page.on('console', (m) => { if (m.type() === 'error') errors.console.push(m.text()); });
  page.on('pageerror', (e) => errors.page.push(e.message));
  const state = { requests: [], drawCount: 0 };

  await page.route('https://www.youtube.com/iframe_api', (r) =>
    r.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body: YT_DOUBLE_SCRIPT }),
  );
  await page.route('**/api/playlist/random*', async (route) => {
    const url = new URL(route.request().url());
    const count = Number(url.searchParams.get('count') || 10);
    const mode = url.searchParams.get('mode') || 'all';
    const minScore = Number(url.searchParams.get('minScore') || 85);
    const onePerArtist = url.searchParams.get('onePerArtist') !== 'false';
    state.requests.push({ count, mode, minScore, onePerArtist });

    const eligible = POOL.filter(
      (s) => s.confidenceScore >= minScore && (mode !== 'favorites' || s.totalPlays >= 3),
    );
    state.drawCount += 1;
    const offset = (state.drawCount <= 2 ? 0 : state.drawCount - 2) % eligible.length;
    const rotated = eligible.slice(offset).concat(eligible.slice(0, offset));
    const songs = rotated.slice(0, count);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ count: songs.length, poolSize: eligible.length, minScore, mode, onePerArtist, songs }),
    });
  });

  return { state, errors };
}

const expectNoOverflow = async (page) => {
  const m = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(m.w).toBeLessThanOrEqual(m.iw);
};

const expectNoErrors = (errors) => {
  expect(errors.console).toEqual([]);
  expect(errors.page).toEqual([]);
};

test.describe('Persistent Broadcast Booth & Now Playing Mini-Bar', () => {
  test('lazy-mounts zero playlist host, YouTube iframe, or /api/playlist/random requests before visiting /playlist', async ({ page }) => {
    const { state, errors } = await setupBackgroundBooth(page);

    await page.goto('/');
    await expect(page.locator('#kpi-episodes')).toBeVisible();
    expect(state.requests).toHaveLength(0);
    await expect(page.locator('.playlist-persistent-host')).toHaveCount(0);
    await expect(page.locator('iframe')).toHaveCount(0);
    await expect(page.locator('.playlist-minibar')).toHaveCount(0);

    await page.goto('/artists');
    await expect(page.getByRole('heading', { name: 'Artists', level: 1 })).toBeVisible();
    expect(state.requests).toHaveLength(0);
    await expect(page.locator('.playlist-persistent-host')).toHaveCount(0);
    await expect(page.locator('iframe')).toHaveCount(0);
    await expect(page.locator('.playlist-minibar')).toHaveCount(0);
    expectNoErrors(errors);
  });

  test('desktop: background playback, off-route query-param isolation, transport, auto-advance, Booth return, and Stop', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Desktop viewport spec');
    const { state, errors } = await setupBackgroundBooth(page);
    const rowSongs = page.locator('.booth-table tbody .booth-song-btn');
    const sidebarNav = page.locator('.cockpit-nav');
    const minibar = page.locator('aside.playlist-minibar[aria-label="Now playing"]');

    await page.goto('/playlist?mode=favorites');
    await expect(rowSongs).toHaveCount(10);
    expect(state.requests.length).toBeGreaterThanOrEqual(1);
    expect(state.requests.every((r) => r.mode === 'favorites' && r.count === 10)).toBe(true);
    const initialDrawRequests = state.requests.length;
    await expect(minibar).toHaveCount(0);
    const initialQueue = await rowSongs.allTextContents();

    // Start playback on slot 02 (Crosby, Stills & Nash — Suite: Judy Blue Eyes).
    await rowSongs.nth(1).click();
    await expect(page.locator('.booth-status-chip.is-playing')).toHaveText('Playing');

    // Navigate across routes and push off-route query params (?q=Allison&artist=...).
    await sidebarNav.getByRole('link', { name: 'Episodes' }).click();
    await expect(page.getByRole('heading', { name: 'Episodes', level: 1 })).toBeVisible();
    await sidebarNav.getByRole('link', { name: 'Overview' }).click();
    await expect(page.locator('#kpi-episodes')).toBeVisible();
    await sidebarNav.getByRole('link', { name: 'Artists' }).click();
    await expect(page.getByRole('heading', { name: 'Artists', level: 1 })).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search artists' }).fill('Allison');
    await expect(page).toHaveURL((u) => u.pathname === '/artists' && u.searchParams.get('q') === 'Allison');
    await page.locator('#artists-table tbody tr').filter({ hasText: 'Allison Moorer' }).first().click();
    await expect(page).toHaveURL((u) => u.pathname === '/artists' && u.searchParams.get('artist') === 'Allison Moorer');

    // Player instance was never destroyed and off-route searchParams triggered zero playlist draws.
    expect(state.requests).toHaveLength(initialDrawRequests);
    expect(await page.evaluate(() => window.__ytTest.calls.filter((c) => c.method === 'destroy').length)).toBe(0);

    const offrouteHost = page.locator('.playlist-persistent-host.is-offroute');
    await expect(offrouteHost).toHaveAttribute('aria-hidden', 'true');
    expect(await offrouteHost.evaluate((el) => el.hasAttribute('inert'))).toBe(true);
    await expectNoOverflow(page);

    // Verify mini-bar live telemetry and Pause / Resume controls.
    await expect(minibar).toBeVisible();
    await expect(minibar.locator('.status-dot.is-live')).toBeVisible();
    await expect(minibar.locator('.playlist-minibar-slot')).toHaveText('02/10');
    await expect(minibar.locator('.playlist-minibar-song')).toHaveText('Suite: Judy Blue Eyes');
    await expect(minibar.locator('.playlist-minibar-artist')).toHaveText('Crosby, Stills & Nash');
    const pauseBtn = minibar.getByRole('button', { name: 'Pause playback' });
    await expect(pauseBtn).toHaveClass(/is-playing/);

    await pauseBtn.click();
    const resumeBtn = minibar.getByRole('button', { name: 'Resume playback' });
    await expect(resumeBtn).toBeVisible();
    await expect(minibar.locator('.status-dot.is-static')).toBeVisible();
    expect(await page.evaluate(() => window.__ytTest.calls.at(-1))).toEqual({ method: 'pauseVideo', videoId: 'vid-csn-01' });

    await resumeBtn.click();
    await expect(minibar.getByRole('button', { name: 'Pause playback' })).toBeVisible();
    await expect(minibar.locator('.status-dot.is-live')).toBeVisible();
    expect(await page.evaluate(() => window.__ytTest.calls.at(-1))).toEqual({ method: 'playVideo', videoId: 'vid-csn-01' });

    // Next song -> 03/10, then background ENDED -> auto-advances to 04/10!
    await minibar.getByRole('button', { name: 'Next song' }).click();
    await expect(minibar.locator('.playlist-minibar-slot')).toHaveText('03/10');
    await expect(minibar.locator('.playlist-minibar-song')).toHaveText('The Rock And The Hill');
    expect(await page.evaluate(() => window.__ytTest.calls.some((c) => c.method === 'loadVideoById' && c.videoId === 'vid-am-01'))).toBe(true);

    await page.evaluate(() => window.__ytTest.emitState(0));
    await expect(minibar.locator('.playlist-minibar-slot')).toHaveText('04/10');
    await expect(minibar.locator('.playlist-minibar-song')).toHaveText('Witness');
    await expect(minibar.locator('.playlist-minibar-artist')).toHaveText('Eilen Jewell');
    await expect(minibar.locator('.status-dot.is-live')).toBeVisible();

    // Return to Broadcast Booth preserves exact queue, slot 04, Playing status, and makes 0 new API calls.
    await minibar.getByRole('link', { name: 'Open Broadcast Booth' }).click();
    await expect(page).toHaveURL('/playlist?mode=favorites');
    await expect(minibar).toHaveCount(0);
    expect(await rowSongs.allTextContents()).toEqual(initialQueue);
    await expect(page.locator('.booth-deck .booth-region-title')).toContainText('04/10');
    await expect(page.locator('.booth-status-chip.is-playing')).toHaveText('Playing');
    expect(state.requests).toHaveLength(initialDrawRequests);

    // Navigate off-route again and Stop playback -> pauses video and dismisses mini-bar.
    await sidebarNav.getByRole('link', { name: 'Overview' }).click();
    await expect(minibar).toBeVisible();
    const pauseCountBeforeStop = await page.evaluate(() => window.__ytTest.calls.filter((c) => c.method === 'pauseVideo').length);
    await minibar.getByRole('button', { name: 'Stop playback' }).click();
    await expect(minibar).toHaveCount(0);
    expect(await page.evaluate(() => window.__ytTest.calls.filter((c) => c.method === 'pauseVideo').length)).toBe(pauseCountBeforeStop + 1);
    expectNoErrors(errors);
  });

  test('desktop: 2-hour localStorage session restore on reload, TTL expiry refresh, and Roll 10 overwrite', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Desktop viewport spec');
    const { state, errors } = await setupBackgroundBooth(page);
    const rowSongs = page.locator('.booth-table tbody .booth-song-btn');

    await page.goto('/playlist?mode=favorites');
    await expect(rowSongs).toHaveCount(10);
    expect(state.requests.length).toBeGreaterThanOrEqual(1);
    const initialDrawRequests = state.requests.length;
    await rowSongs.nth(2).click();
    await expect(page.locator('.booth-deck .booth-region-title')).toContainText('03/10');
    const firstQueue = await rowSongs.allTextContents();

    // Reload within 2-hour TTL: restores queue + active slot 03 with 0 network draws.
    await page.reload();
    await expect(rowSongs).toHaveCount(10);
    expect(await rowSongs.allTextContents()).toEqual(firstQueue);
    await expect(page.locator('.booth-deck .booth-region-title')).toContainText('03/10');
    expect(state.requests).toHaveLength(initialDrawRequests);

    // Age savedAt past 2 hours and reload: fetches a fresh draw.
    await page.evaluate((key) => {
      const parsed = JSON.parse(window.localStorage.getItem(key));
      parsed.savedAt = Date.now() - (2 * 60 * 60 * 1000 + 5000);
      window.localStorage.setItem(key, JSON.stringify(parsed));
    }, STORAGE_KEY);
    await page.reload();
    await expect(rowSongs).toHaveCount(10);
    expect(state.requests.length).toBeGreaterThan(initialDrawRequests);
    const postExpiryRequests = state.requests.length;
    const secondQueue = await rowSongs.allTextContents();
    expect(secondQueue).not.toEqual(firstQueue);

    // Clicking Roll 10 draws a fresh queue and overwrites localStorage.
    await page.getByRole('button', { name: 'Roll 10' }).click();
    await expect.poll(() => state.requests.length).toBe(postExpiryRequests + 1);
    await expect.poll(() => rowSongs.allTextContents()).not.toEqual(secondQueue);
    const thirdQueue = await rowSongs.allTextContents();
    const storedTitles = await page.evaluate(
      (key) => JSON.parse(window.localStorage.getItem(key)).queue.map((s) => s.songTitle),
      STORAGE_KEY,
    );
    expect(storedTitles).toEqual(thirdQueue);
    expectNoErrors(errors);
  });

  test('mobile 375x812 & 320x667: mini-bar above bottom tabs, >=44x44 touch targets, hidden tooltips, and theme tokens', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-375', 'Mobile viewport spec');
    const { errors } = await setupBackgroundBooth(page);
    const minibar = page.locator('aside.playlist-minibar[aria-label="Now playing"]');
    const mobileTabs = page.locator('.mobile-bottom-tabs');

    await page.goto('/playlist');
    await expect(page.locator('.booth-mobile-row')).toHaveCount(10);
    await page.locator('.booth-mobile-song').nth(1).click();
    await expect(page.locator('.booth-status-chip.is-playing')).toHaveText('Playing');

    await mobileTabs.getByRole('link', { name: 'Overview' }).click();
    await expect(page.locator('#kpi-episodes')).toBeVisible();
    await expect(minibar).toBeVisible();
    await expectNoOverflow(page);

    const checkMobileBarGeometry = async () => {
      const barBox = await minibar.boundingBox();
      const tabsBox = await mobileTabs.boundingBox();
      expect(barBox.y + barBox.height).toBeLessThanOrEqual(tabsBox.y + 1);

      const linkBox = await minibar.locator('.playlist-minibar-link').boundingBox();
      expect(linkBox.width).toBeGreaterThanOrEqual(44);
      expect(linkBox.height).toBeGreaterThanOrEqual(44);

      const actionBtns = minibar.locator('button.playlist-minibar-btn');
      await expect(actionBtns).toHaveCount(4);
      for (let i = 0; i < 4; i += 1) {
        const box = await actionBtns.nth(i).boundingBox();
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
      for (const bubble of await minibar.locator('.tooltip-bubble').all()) {
        await expect(bubble).toBeHidden();
      }
    };

    await checkMobileBarGeometry();

    // Toggle light/dark theme and verify design tokens remain clean.
    await page.locator('.mobile-theme-btn').click();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--as-bg-base').trim())).toBe('#f4f4f6');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--as-accent-fg').trim())).toBe('#3f6212');
    await expectNoOverflow(page);

    await page.locator('.mobile-theme-btn').click();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');

    // Narrow 320x667 check.
    await page.setViewportSize({ width: 320, height: 667 });
    await checkMobileBarGeometry();
    await expectNoOverflow(page);
    expectNoErrors(errors);
  });
});
