// Client telemetry controller for YT Music Links and Song Metadata & Data Load tabs.
const $ = (id) => document.getElementById(id);
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);
const fmtInt = (n) => Number(n || 0).toLocaleString('en-US');
const fmtBytes = (b) => {
  const bytes = Number(b || 0);
  if (bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};
const fmtMmSs = (sec) => {
  const s = Math.max(0, Math.round(Number(sec || 0)));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const fmtDur = (sec) => {
  if (sec === null || sec === undefined) return '--';
  if (sec <= 0) return 'Done';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${sec % 60}s`;
};
const fmtEta = (sec, iso) => {
  if (sec === 0) return 'Done';
  if (sec === null || sec === undefined) return '--';
  const ts = iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  return ts ? `${fmtDur(sec)} (${ts})` : fmtDur(sec);
};
const fmtClock = (iso) => {
  if (!iso) return '--';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleTimeString([], { hour12: false });
};

let activeTab = 'links';
let lastLinks = null;
let lastMeta = null;
let polling = false;

function resolveLinksPill(rt) {
  if (rt.alive) {
    if (rt.phase === 'initial_cooldown' || rt.phase === 'batch_cooldown' || rt.phase === 'retry_backoff') {
      return { cls: 'cooling', text: 'COOLING DOWN' };
    }
    return { cls: 'alive', text: 'ALIVE' };
  }
  if (rt.pid && rt.phase && rt.phase !== 'completed' && rt.phase !== 'idle') return { cls: 'stopped', text: 'STOPPED' };
  return { cls: 'idle', text: 'IDLE' };
}

function resolveMetaPill(rt) {
  if (rt.alive) return { cls: 'alive', text: 'RUNNING' };
  if (rt.phase === 'completed') return { cls: 'alive', text: 'COMPLETED' };
  if (rt.phase === 'stale' || rt.phase === 'stopped') return { cls: 'stopped', text: rt.phase.toUpperCase() };
  return { cls: 'info', text: 'READY' };
}

function syncHeader() {
  if (activeTab === 'links' && lastLinks) {
    const rt = lastLinks.runtime || {};
    const pill = resolveLinksPill(rt);
    $('headerTitle').textContent = 'THROUGH THE CRACKS // YT MUSIC DISCOVERY';
    $('statusPill').className = `pill ${pill.cls}`;
    $('statusPill').textContent = pill.text;
    $('metaPhase').textContent = rt.phase || 'idle';
    $('metaPid').textContent = rt.pid ?? '--';
    $('metaPace').textContent = `${Number(rt.paceMultiplier ?? 1).toFixed(2)}x`;
    $('subStatus').textContent = rt.alive
      ? `YT Music active | started ${fmtClock(rt.startedAt)} | processed ${fmtInt(rt.processedInRun)} / ${fmtInt(rt.pendingTotal)}`
      : 'No active YT Music discovery process';
  } else if (activeTab === 'metadata' && lastMeta) {
    const rt = lastMeta.runtime || {};
    const cat = lastMeta.catalog || {};
    const pill = resolveMetaPill(rt);
    $('headerTitle').textContent = 'THROUGH THE CRACKS // METADATA & DATA LOAD';
    $('statusPill').className = `pill ${pill.cls}`;
    $('statusPill').textContent = pill.text;
    $('metaPhase').textContent = rt.phase || 'idle';
    $('metaPid').textContent = rt.pid ?? '--';
    $('metaPace').textContent = '1.60s MB / 1.08s DC';
    $('subStatus').textContent = rt.alive
      ? `Metadata active | ${fmtInt(rt.albumsProcessed)} / ${fmtInt(rt.totalAlbumsTarget)} Albums | ${fmtInt(rt.songsWritten)} Songs`
      : `Staged catalog: ${fmtInt(cat.totalSongs)} Songs across ${fmtInt(cat.albumGroupCount)} Albums (${fmtInt(cat.overallCompleted)} checkpointed)`;
  }
}

function updateCooldownTick() {
  if (!lastLinks) return;
  const rt = lastLinks.runtime || {};
  const rem = rt.cooldownUntil ? Math.max(0, Math.round((Date.parse(rt.cooldownUntil) - Date.now()) / 1000)) : 0;
  $('cooldownTimer').textContent = rem > 0 ? fmtMmSs(rem) : '00:00';
}

function renderLinks(data) {
  lastLinks = data;
  const { catalog: cat, tiers, runtime: rt, throughput: tp } = data;
  $('tabCountLinks').textContent = `${fmtInt(cat.overallCompleted)}/${fmtInt(cat.totalSongs)}`;

  $('overallDone').textContent = fmtInt(cat.overallCompleted);
  $('overallTotal').textContent = `/ ${fmtInt(cat.totalSongs)}`;
  $('overallPct').textContent = `${Number(cat.overallPct).toFixed(2)}%`;
  $('overallBar').style.width = `${Math.min(100, cat.overallPct)}%`;

  $('pass1Done').textContent = fmtInt(cat.pass1Completed);
  $('pass1Total').textContent = `/ ${fmtInt(cat.pass1MultiTotal)}`;
  $('pass1Pct').textContent = `${Number(cat.pass1Pct).toFixed(2)}%`;
  $('pass1Bar').style.width = `${Math.min(100, cat.pass1Pct)}%`;

  $('pass2Done').textContent = fmtInt(cat.pass2Completed);
  $('pass2Total').textContent = `/ ${fmtInt(cat.pass2SingleTotal)}`;
  $('pass2Pct').textContent = `${Number(cat.pass2Pct).toFixed(2)}%`;
  $('pass2Bar').style.width = `${Math.min(100, cat.pass2Pct)}%`;
  $('livePoolCount').textContent = fmtInt(cat.productionLivePool);

  $('passModeTag').textContent = `pass=${rt.passMode || '--'}`;
  $('batchProgress').textContent = `${rt.batchIndex} / ${rt.totalBatches} (${rt.batchProcessed} / ${rt.batchSize})`;
  updateCooldownTick();
  $('effectiveJitter').textContent = `${Number(rt.effectiveMinJitter || 0).toFixed(2)}s - ${Number(rt.effectiveMaxJitter || 0).toFixed(2)}s`;
  $('cleanStreakVal').textContent = fmtInt(rt.cleanStreak);
  $('currentSongVal').textContent = rt.currentSong
    ? `${rt.currentSong.artist} - ${rt.currentSong.songTitle}`
    : (rt.cooldownRemainingSec > 0 ? `Cooldown (${rt.phase})` : '--');

  $('windowCounts').textContent = `15m: ${fmtInt(tp.songsLast15m)} | 60m: ${fmtInt(tp.songsLast60m)}`;
  $('observedRate').textContent = `${Number(tp.observedSongsPerMin).toFixed(2)} songs/min`;
  $('configuredRate').textContent = `${Number(tp.configuredSongsPerMin).toFixed(2)} songs/min (eff ${Number(tp.effectiveSongsPerMin).toFixed(2)})`;
  $('pass1Eta').textContent = fmtEta(tp.pass1EtaSeconds, tp.pass1EtaIso);
  $('fullEta').textContent = fmtEta(tp.fullCatalogEtaSeconds, tp.fullCatalogEtaIso);
  $('remainingQueue').textContent = `Pass 1: ${fmtInt(tp.pass1Remaining)} | Full: ${fmtInt(tp.fullCatalogRemaining)}`;

  const tot = tiers.totalChecked || 0;
  $('matchRateLabel').textContent = `${Number(tiers.matchRatePct).toFixed(2)}% matched (${fmtInt(tiers.matchedTotal)} / ${fmtInt(tot)})`;
  $('segHigh').style.width = `${tot > 0 ? (tiers.high / tot) * 100 : 0}%`;
  $('segMedium').style.width = `${tot > 0 ? (tiers.medium / tot) * 100 : 0}%`;
  $('segLow').style.width = `${tot > 0 ? (tiers.low / tot) * 100 : 0}%`;
  $('segUnmatched').style.width = `${tot > 0 ? (tiers.unmatched / tot) * 100 : 0}%`;
  $('tierHigh').textContent = fmtInt(tiers.high);
  $('tierMedium').textContent = fmtInt(tiers.medium);
  $('tierLow').textContent = fmtInt(tiers.low);
  $('tierUnmatched').textContent = fmtInt(tiers.unmatched);
  $('tierMatched').textContent = fmtInt(tiers.matchedTotal);

  $('retryCountLabel').textContent = `${fmtInt(rt.retryCount)} retries`;
  $('retriesBox').innerHTML = rt.recentRetries?.length
    ? rt.recentRetries.map((r) => `<div class="retry-item">[${esc(fmtClock(r.at))}] ${esc(r.searchFilter)} "${esc(r.query)}" backoff=${esc(r.backoffSeconds)}s :: ${esc(r.error)}</div>`).join('')
    : '<div class="empty">No retries logged.</div>';

  const logEl = $('logTail');
  const stickBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;
  $('logCountLabel').textContent = `${data.logTail?.length || 0} lines`;
  logEl.textContent = data.logTail?.length ? data.logTail.join('\n') : 'No log lines available.';
  if (stickBottom) logEl.scrollTop = logEl.scrollHeight;

  $('recentBody').innerHTML = data.recentMatches?.length
    ? data.recentMatches.map((m) => {
      const vidCell = m.videoId
        ? `<a class="yt-link" href="https://www.youtube.com/watch?v=${encodeURIComponent(m.videoId)}" target="_blank" rel="noopener noreferrer">${esc(m.videoId)}</a>`
        : '--';
      return `<tr><td>${esc(m.artist)}</td><td>${esc(m.songTitle)}</td><td class="mono">${esc(m.confidenceScore)}</td><td><span class="tier-badge badge-${esc(m.matchTier)}">${esc(m.matchTier)}</span></td><td>${vidCell}</td><td class="mono">${esc(fmtClock(m.checkedAt))}</td></tr>`;
    }).join('')
    : '<tr><td colspan="6" class="empty">Waiting for checkpoint entries.</td></tr>';
  syncHeader();
}

function renderMetadata(data) {
  lastMeta = data;
  const { catalog: cat, workload: wl, runtime: rt, throughput: tp, sources: src, reconciled: rec } = data;
  $('tabCountMetadata').textContent = `${fmtInt(cat.overallCompleted)}/${fmtInt(cat.totalSongs)}`;

  $('mOverallDone').textContent = fmtInt(cat.overallCompleted);
  $('mOverallTotal').textContent = `/ ${fmtInt(cat.totalSongs)} Songs`;
  $('mOverallPct').textContent = `${Number(cat.overallPct).toFixed(1)}%`;
  $('mOverallBar').style.width = `${Math.min(100, cat.overallPct)}%`;
  $('mArtistsCountMeta').textContent = `${fmtInt(cat.totalArtists)} Artists | ${fmtInt(cat.highSpinSongs)} High-Spin (>=5)`;

  $('mAlbumsDone').textContent = fmtInt(cat.albumsCompleted);
  $('mAlbumsTotal').textContent = `/ ${fmtInt(cat.albumGroupCount)} Albums`;
  $('mAlbumsPct').textContent = `${Number(cat.albumsPct).toFixed(1)}%`;
  $('mAlbumsBar').style.width = `${Math.min(100, cat.albumsPct)}%`;
  $('mAlbumCompressionMeta').textContent = `${fmtInt(cat.albumCoveredSongs)} Album Songs (${cat.albumCoveredPct}%) + ${fmtInt(cat.singleSongs)} Singles`;

  $('mPass1Done').textContent = fmtInt(cat.pass1Completed);
  $('mPass1Total').textContent = `/ ${fmtInt(cat.pass1MultiTotal)}`;
  $('mPass1Pct').textContent = `${Number(cat.pass1Pct).toFixed(1)}%`;
  $('mPass1Bar').style.width = `${Math.min(100, cat.pass1Pct)}%`;
  $('mPass2Meta').textContent = `Pass 2 Single-Spin: ${fmtInt(cat.pass2Completed)} / ${fmtInt(cat.pass2SingleTotal)} (${cat.pass2Pct}%)`;

  $('mSqlCount').textContent = fmtInt(rec?.discoveredSongs || cat.reconciledSongs || 0);
  $('mSqliteMeta').textContent = `http-cache: ${fmtBytes(cat.httpCacheBytes)} | sqlite: ${fmtBytes(cat.sqliteBytes)}`;
  const sufCount = rec?.uncleanedSuffixCount;
  $('mSuffixBadge').textContent = sufCount === undefined ? 'Suffixes: --' : `Suffixes: ${sufCount}`;
  $('mSuffixBadge').className = `pill ${sufCount === 0 ? 'alive' : sufCount > 0 ? 'stopped' : ''}`;

  const auth = rt.authModes || {};
  $('mSourcesTag').textContent = `sources=${rt.sources?.length ? rt.sources.join(',') : 'mb,discogs,wiki'}`;
  $('mAuthDiscogs').textContent = auth.discogs ? `${auth.discogs} (60/min)` : 'consumer_key_secret (60/min)';
  if (auth.shs === 'api_key') {
    $('mAuthMbShs').textContent = 'MB 1.60s | SHS 1.10s key';
  } else {
    $('mAuthMbShs').innerHTML = 'MB 1.60s | SHS pending (<a class="yt-link" href="https://secondhandsongs.com/api-key-request/376" target="_blank" rel="noopener noreferrer">req 376</a>)';
  }
  $('mPass1ReqEst').textContent = `~${fmtInt(wl.pass1EstMbRequests)} MB + ~${fmtInt(wl.pass1EstDiscogsRequests)} DC`;
  $('mFullReqEst').textContent = `~${fmtInt(wl.fullEstMbRequests)} MB + ~${fmtInt(wl.fullEstDiscogsRequests)} DC`;
  const mbRs = rt.rateStats?.mb;
  const dcRs = rt.rateStats?.discogs;
  $('mCacheStats').textContent = mbRs || dcRs
    ? `req=${(mbRs?.requests || 0) + (dcRs?.requests || 0)} | cache=${(mbRs?.cache_hits || 0) + (dcRs?.cache_hits || 0)} | err=${rt.errorCount}`
    : 'Ready for initial pass';
  $('mCurrentItem').textContent = rt.currentItem || (cat.overallCompleted > 0 ? 'Smoke checkpoint complete' : 'Idle');

  $('mWindowCounts').textContent = `15m: ${fmtInt(tp.songsLast15m)} | 60m: ${fmtInt(tp.songsLast60m)}`;
  $('mObservedRate').textContent = `${Number(tp.observedSongsPerMin).toFixed(2)} songs/min`;
  $('mConfiguredRate').textContent = `${Number(tp.configuredSongsPerMin).toFixed(2)} songs/min`;
  $('mPass1Eta').textContent = fmtEta(tp.pass1EtaSeconds, tp.pass1EtaIso);
  $('mFullEta').textContent = fmtEta(tp.fullCatalogEtaSeconds, tp.fullCatalogEtaIso);
  $('mRemainingQueue').textContent = `Pass 1: ${fmtInt(wl.pass1RemainingAlbums)} Albums + ${fmtInt(wl.pass1RemainingSingles)} Singles | Full: ${fmtInt(wl.fullRemainingAlbums)} Albums`;

  $('mTierTotalLabel').textContent = `${fmtInt(cat.totalSongs)} Songs`;
  $('mSpinTiersList').innerHTML = (data.spinTiers || []).map((t) =>
    `<div><div class="tier-row-meta"><span>${esc(t.label)}</span><span class="mono">${fmtInt(t.completed)} / ${fmtInt(t.total)} (${t.pct}%)</span></div>` +
    `<div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, t.pct)}%"></div></div></div>`,
  ).join('');
  $('mTopArtistsChips').innerHTML = (data.topArtistsLoad || []).slice(0, 8).map((a) =>
    `<span class="chip">${esc(a.artist)}: <strong>${fmtInt(a.completedCount)}/${fmtInt(a.songCount)}</strong> (${fmtInt(a.totalPlays)} Spins)</span>`,
  ).join('');

  $('mSourceHitSummary').textContent = `${fmtInt(src.totalChecked)} checked (${src.anyHitPct}% any)`;
  $('mSourcePills').innerHTML = [
    ['MB', src.mbHits, src.mbPct], ['Discogs', src.discogsHits, src.discogsPct],
    ['Wiki Bio', src.wikiHits, src.wikiPct], ['SHS', src.shsHits, src.shsPct],
  ].map(([lbl, cnt, p]) => `<span class="src-pill ${cnt > 0 ? 'hit' : ''}">${lbl}: ${fmtInt(cnt)} (${p}%)</span>`).join('');

  const cov = rec?.coverage;
  $('mCoverageBars').innerHTML = cov ? [
    ['Release Year', cov.releaseYearPct, cov.releaseYearCount],
    ['Songwriters', cov.writersPct, cov.writersCount],
    ['Session Personnel', cov.personnelPct, cov.personnelCount],
    ['Recording Studios', cov.studiosPct, cov.studiosCount],
    ['Artist Bio', cov.artistBioPct, cov.artistBioCount],
  ].map(([lbl, p, cnt]) =>
    `<div><div class="tier-row-meta"><span>${lbl}</span><span class="mono">${cnt} Songs (${p}%)</span></div>` +
    `<div class="bar-track"><div class="bar-fill info" style="width:${Math.min(100, p)}%"></div></div></div>`,
  ).join('') : '<div class="empty">Run npm run song-metadata:reconcile to inspect SQLite field coverage.</div>';

  $('mTopCreditsChips').innerHTML = rec ? [
    ...(rec.topWriters || []).slice(0, 3).map((w) => `<span class="chip">Writer: <strong>${esc(w.name)}</strong> (${w.count})</span>`),
    ...(rec.topStudios || []).slice(0, 3).map((st) => `<span class="chip">Studio: <strong>${esc(st.name)}</strong> (${st.count})</span>`),
  ].join('') : '';

  $('mQueueTag').textContent = `${data.upcomingAlbums?.length || 0} NEXT BY SPINS`;
  $('mUpcomingBody').innerHTML = data.upcomingAlbums?.length
    ? data.upcomingAlbums.map((a) =>
      `<tr><td>${esc(a.artist)}</td><td>${esc(a.album)}</td><td class="mono">${fmtInt(a.totalPlays)}</td>` +
      `<td class="mono">${fmtInt(a.songCount)}</td><td class="mono">${fmtInt(a.multiSpinCount)}</td><td class="mono">${fmtInt(a.completedCount)}/${fmtInt(a.songCount)}</td></tr>`,
    ).join('')
    : '<tr><td colspan="6" class="empty">All catalog Albums are checkpointed.</td></tr>';

  $('mSampleTag').textContent = `${rec?.sampleSongs?.length || 0} SAMPLES`;
  $('mSamplesList').innerHTML = rec?.sampleSongs?.length
    ? rec.sampleSongs.slice(0, 6).map((s) => {
      const metaLine = [
        s.release_year ? `Year: ${s.release_year}` : null,
        s.writers?.length ? `Writers: ${s.writers.join(', ')}` : null,
        s.primary_studio ? `Studio: ${s.primary_studio}` : null,
      ].filter(Boolean).join(' | ');
      const facts = (s.facts || []).join(' ');
      return `<div class="fact-item"><div class="fact-head">${esc(s.artist)} - ${esc(s.song_title)} (${fmtInt(s.totalPlays)} Spins)</div>` +
        `<div class="fact-sub">${esc(metaLine || 'No reconciled liner credits')}</div>` +
        (facts ? `<div class="fact-sub">${esc(facts)}</div>` : '') + '</div>';
    }).join('')
    : '<div class="empty">Run npm run song-metadata:reconcile to preview liner notes.</div>';

  $('mRecentBody').innerHTML = data.recentCheckpoints?.length
    ? data.recentCheckpoints.map((r) => {
      const pills = [['MB', r.mbFound], ['DC', r.discogsFound], ['Wiki', r.wikiFound], ['SHS', r.shsFound]]
        .map(([lbl, ok]) => `<span class="src-pill ${ok ? 'hit' : ''}">${lbl}</span>`).join('');
      return `<tr><td><strong>${esc(r.artist)}</strong> - ${esc(r.songTitle)}</td><td>${esc(r.album || 'Single')}</td>` +
        `<td class="mono">${esc(r.releaseYear || '--')}</td><td>${pills}</td><td class="mono">${esc(fmtClock(r.checkedAt))}</td></tr>`;
    }).join('')
    : '<tr><td colspan="5" class="empty">Waiting for metadata checkpoints.</td></tr>';

  const mLogEl = $('mLogTail');
  $('mLogCountLabel').textContent = `${data.logTail?.length || 0} lines`;
  mLogEl.textContent = data.logTail?.length ? data.logTail.join('\n') : 'No metadata log lines available.';
  syncHeader();
}

function setActiveTab(tab, pushUrl = true) {
  activeTab = tab === 'metadata' ? 'metadata' : 'links';
  const isMeta = activeTab === 'metadata';
  $('panelLinks').hidden = isMeta;
  $('panelMetadata').hidden = !isMeta;
  $('tabBtnLinks').classList.toggle('is-active', !isMeta);
  $('tabBtnLinks').setAttribute('aria-selected', String(!isMeta));
  $('tabBtnMetadata').classList.toggle('is-active', isMeta);
  $('tabBtnMetadata').setAttribute('aria-selected', String(isMeta));
  if (pushUrl) {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', activeTab);
    window.history.replaceState(null, '', url.toString());
  }
  syncHeader();
}

function initControls() {
  $('tabBtnLinks').addEventListener('click', () => setActiveTab('links', true));
  $('tabBtnMetadata').addEventListener('click', () => setActiveTab('metadata', true));
  $('themeToggle').addEventListener('click', () => {
    const root = document.documentElement;
    const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    $('themeLabel').textContent = next === 'light' ? 'Daylight' : 'Obsidian';
  });

  const qTab = new URLSearchParams(window.location.search).get('tab');
  const defaultTab = document.documentElement.dataset.defaultTab;
  const initialTab = qTab === 'metadata' || qTab === 'links'
    ? qTab
    : (window.location.pathname === '/metadata' || defaultTab === 'metadata' ? 'metadata' : 'links');
  setActiveTab(initialTab, false);
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const [linksRes, metaRes] = await Promise.all([
      fetch('/api/status', { cache: 'no-store' }),
      fetch('/api/metadata-status', { cache: 'no-store' }),
    ]);
    if (linksRes.ok) renderLinks(await linksRes.json());
    if (metaRes.ok) renderMetadata(await metaRes.json());
    $('pollIndicator').textContent = `POLL 2S // ${new Date().toLocaleTimeString([], { hour12: false })}`;
  } catch (err) {
    $('pollIndicator').textContent = `POLL ERR // ${err.message}`;
  } finally {
    polling = false;
  }
}

initControls();
poll();
setInterval(poll, 2000);
setInterval(updateCooldownTick, 1000);
