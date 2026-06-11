// ==UserScript==
// @name         C411 - Pastilles torrents telecharges
// @namespace    https://c411.org/
// @version      0.2.6
// @description  Marque les torrents deja telecharges sur C411 avec des pastilles DL et ALT.
// @author       Butchered
// @icon         https://c411.org/favicon.ico
// @match        https://c411.org/*
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  "use strict";

  const STORAGE_KEY = "c411DownloadedBadges.cache.v1";
  const DETAILS_KEY = "c411DownloadedBadges.details.v1";
  const SETTINGS_KEY = "c411DownloadedBadges.settings.v1";
  const RECENT_DOWNLOAD_CLICK_KEY = "c411DownloadedBadges.recentDownloadClick.v1";
  const HASH_RE = /\/torrents\/([a-f0-9]{40})(?:[/?#]|$)/i;
  const PROFILE_SOURCES = [
    {
      key: "downloads",
      label: "telechargements",
      path: "/api/profile/downloads",
      required: true,
    },
    {
      key: "active-seeds",
      label: "seeds actifs",
      path: "/api/profile/active-seeds",
      required: true,
    },
  ];

  const DEFAULT_SETTINGS = {
    autoSyncHours: 24,
    downloadSyncDelayMs: 4000,
    perPage: 50,
    showAltBadge: true,
    maxPagesPerSync: 200,
    mediaDetailCacheDays: 300,
    maxMediaDetailsPerSync: 300,
  };

  const TECHNICAL_TOKENS = new Set([
    "aac",
    "ac3",
    "ad",
    "atmos",
    "av1",
    "avc",
    "bdrip",
    "bluray",
    "br",
    "brrip",
    "custom",
    "dc",
    "ddp",
    "dl",
    "dolby",
    "dts",
    "dv",
    "dvd",
    "dvdrip",
    "eac3",
    "flac",
    "fr",
    "french",
    "full",
    "h264",
    "h265",
    "hdr",
    "hdr10",
    "hdr10plus",
    "hdlight",
    "hevc",
    "imax",
    "light",
    "ma",
    "multi",
    "multilang",
    "proper",
    "pq10",
    "remaster",
    "remastered",
    "remux",
    "rip",
    "sdr",
    "theatrical",
    "truefrench",
    "truehd",
    "uhd",
    "vf",
    "vf2",
    "vff",
    "vfq",
    "vo",
    "vof",
    "vost",
    "vostfr",
    "web",
    "webdl",
    "webrip",
    "x264",
    "x265",
    "xvid",
  ]);

  const state = {
    cache: normalizeCache(GM_getValue(STORAGE_KEY, null)),
    detailCache: normalizeDetailCache(GM_getValue(DETAILS_KEY, null)),
    settings: { ...DEFAULT_SETTINGS, ...GM_getValue(SETTINGS_KEY, {}) },
    exactByHash: new Map(),
    altByKey: new Map(),
    mediaByHash: new Map(),
    altByMediaKey: new Map(),
    syncInProgress: false,
    annotateTimer: null,
    downloadSyncTimer: null,
    detailFetchInProgress: false,
    detailFetchTimer: null,
    detailQueue: [],
    detailQueuedHashes: new Set(),
    statusEl: null,
  };

  addStyles();
  rebuildIndexes();
  registerMenu();
  exposeDebugHelpers();
  renderStatusWidget();
  scheduleAnnotate();
  observePageChanges();
  observeDownloadClicks();
  maybeSyncAfterRecentDownloadClick();
  maybeAutoSync();
  scheduleMediaEnrichment();

  function addStyles() {
    GM_addStyle(`
      .c411-dl-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
        margin-left: 0.35rem;
        min-width: 1.65rem;
        height: 1.05rem;
        padding: 0 0.35rem;
        border-radius: 0.25rem;
        font-size: 10px;
        line-height: 1;
        font-weight: 800;
        letter-spacing: 0;
        vertical-align: middle;
        white-space: nowrap;
        border: 1px solid transparent;
      }

      .c411-dl-badge--row {
        margin-left: 0;
        margin-right: 0.25rem;
      }

      .c411-dl-badge--exact {
        color: #052e16;
        background: #86efac;
        border-color: #22c55e;
      }

      .dark .c411-dl-badge--exact {
        color: #dcfce7;
        background: rgba(34, 197, 94, 0.22);
        border-color: rgba(74, 222, 128, 0.75);
      }

      .c411-dl-badge--alt {
        color: #431407;
        background: #fdba74;
        border-color: #f97316;
      }

      .dark .c411-dl-badge--alt {
        color: #ffedd5;
        background: rgba(249, 115, 22, 0.22);
        border-color: rgba(251, 146, 60, 0.8);
      }

      .c411-dl-badge--seed {
        color: #172554;
        background: #93c5fd;
        border-color: #3b82f6;
      }

      .dark .c411-dl-badge--seed {
        color: #dbeafe;
        background: rgba(59, 130, 246, 0.22);
        border-color: rgba(96, 165, 250, 0.8);
      }

      .c411-dl-badge--seed-ratio-low {
        color: #450a0a;
        background: #fca5a5;
        border-color: #ef4444;
      }

      .dark .c411-dl-badge--seed-ratio-low {
        color: #fee2e2;
        background: rgba(239, 68, 68, 0.24);
        border-color: rgba(248, 113, 113, 0.85);
      }

      .c411-dl-badge--seed-ratio-warn {
        color: #431407;
        background: #fdba74;
        border-color: #f97316;
      }

      .dark .c411-dl-badge--seed-ratio-warn {
        color: #ffedd5;
        background: rgba(249, 115, 22, 0.24);
        border-color: rgba(251, 146, 60, 0.85);
      }

      .c411-dl-badge--seed-ratio-mid {
        color: #422006;
        background: #fde68a;
        border-color: #eab308;
      }

      .dark .c411-dl-badge--seed-ratio-mid {
        color: #fef9c3;
        background: rgba(234, 179, 8, 0.24);
        border-color: rgba(250, 204, 21, 0.85);
      }

      .c411-dl-badge--seed-ratio-good {
        color: #052e16;
        background: #86efac;
        border-color: #22c55e;
      }

      .dark .c411-dl-badge--seed-ratio-good {
        color: #dcfce7;
        background: rgba(34, 197, 94, 0.24);
        border-color: rgba(74, 222, 128, 0.85);
      }

      .c411-dl-badge--seed-ratio-ok {
        color: #083344;
        background: #67e8f9;
        border-color: #06b6d4;
      }

      .dark .c411-dl-badge--seed-ratio-ok {
        color: #cffafe;
        background: rgba(6, 182, 212, 0.24);
        border-color: rgba(34, 211, 238, 0.85);
      }

      .c411-dl-status {
        position: fixed;
        right: 14px;
        bottom: 14px;
        z-index: 99998;
        display: flex;
        align-items: center;
        gap: 8px;
        max-width: min(360px, calc(100vw - 28px));
        padding: 8px 10px;
        border-radius: 8px;
        border: 1px solid rgba(16, 185, 129, 0.35);
        background: rgba(15, 23, 42, 0.92);
        color: #ecfdf5;
        font: 12px/1.25 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
      }

      .c411-dl-status__button {
        appearance: none;
        border: 1px solid rgba(110, 231, 183, 0.55);
        border-radius: 6px;
        background: rgba(16, 185, 129, 0.18);
        color: inherit;
        cursor: pointer;
        font: inherit;
        font-weight: 700;
        padding: 4px 7px;
      }

      .c411-dl-status__button:hover {
        background: rgba(16, 185, 129, 0.3);
      }

      .c411-dl-status__button:disabled {
        cursor: wait;
        opacity: 0.7;
      }

      @media (max-width: 640px) {
        .c411-dl-status {
          right: 8px;
          bottom: 8px;
          font-size: 11px;
        }
      }
    `);
  }

  function registerMenu() {
    GM_registerMenuCommand("C411 DL - Synchroniser maintenant", () => {
      syncDownloads({ force: true }).catch((error) => {
        console.error("[C411 DL] Synchronisation echouee", error);
        updateStatus(`Erreur sync: ${error.message || error}`);
      });
    });

    GM_registerMenuCommand("C411 DL - Vider le cache", () => {
      GM_deleteValue(STORAGE_KEY);
      GM_deleteValue(DETAILS_KEY);
      state.cache = normalizeCache(null);
      state.detailCache = normalizeDetailCache(null);
      rebuildIndexes();
      clearBadges();
      scheduleAnnotate();
      updateStatus("Cache vide");
    });

    GM_registerMenuCommand("C411 DL - Debug API torrent", () => {
      const defaultHash = findDefaultDebugHash();
      const input = window.prompt("InfoHash a tester avec /api/torrents/<hash>", defaultHash);
      if (!input) {
        return;
      }

      debugTorrentApi(input).catch((error) => {
        console.error("[C411 DL] Debug API torrent echoue", error);
        updateStatus(`Debug API echoue: ${error.message || error}`);
      });
    });
  }

  function exposeDebugHelpers() {
    const target = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    target.c411DlDebugTorrent = (hash) => debugTorrentApi(hash || findDefaultDebugHash());
  }

  function renderStatusWidget() {
    const el = document.createElement("div");
    el.className = "c411-dl-status";

    const text = document.createElement("span");
    text.className = "c411-dl-status__text";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "c411-dl-status__button";
    button.textContent = "Sync";
    button.addEventListener("click", () => {
      syncDownloads({ force: true }).catch((error) => {
        console.error("[C411 DL] Synchronisation echouee", error);
        updateStatus(`Erreur sync: ${error.message || error}`);
      });
    });

    el.append(text, button);
    document.body.appendChild(el);

    state.statusEl = el;
    updateStatus(statusSummary());
  }

  function statusSummary() {
    const count = state.cache.releases.length;
    if (!count) {
      return "DL: non synchronise";
    }

    const activeSeeds = countActiveSeedReleases();
    const date = state.cache.syncedAt ? new Date(state.cache.syncedAt) : null;
    const synced = date && !Number.isNaN(date.getTime()) ? formatDate(date) : "date inconnue";
    return `DL: ${count} torrents, seeds actifs: ${activeSeeds}, sync ${synced}`;
  }

  function countActiveSeedReleases() {
    return state.cache.releases.filter(isActiveSeedRelease).length;
  }

  function updateStatus(message) {
    if (!state.statusEl) {
      return;
    }

    const text = state.statusEl.querySelector(".c411-dl-status__text");
    const button = state.statusEl.querySelector(".c411-dl-status__button");
    text.textContent = message;
    button.disabled = state.syncInProgress;
  }

  async function maybeAutoSync() {
    if (state.syncInProgress) {
      return;
    }

    if (!state.cache.syncedAt || isCacheStale()) {
      try {
        await syncDownloads({ force: false });
      } catch (error) {
        console.error("[C411 DL] Synchronisation automatique echouee", error);
        updateStatus(`Sync auto echouee: ${error.message || error}`);
      }
    }
  }

  function isCacheStale() {
    const syncedAt = Date.parse(state.cache.syncedAt || "");
    if (!syncedAt) {
      return true;
    }

    const maxAgeMs = state.settings.autoSyncHours * 60 * 60 * 1000;
    return Date.now() - syncedAt > maxAgeMs;
  }

  function observeDownloadClicks() {
    document.addEventListener(
      "click",
      (event) => {
        const action = event.target && event.target.closest
          ? event.target.closest("a, button, [role='button']")
          : null;

        if (!action || state.statusEl?.contains(action)) {
          return;
        }

        if (isDownloadAction(action)) {
          addManualDownloadFromAction(action);
          scheduleSyncAfterDownloadClick();
        }
      },
      true,
    );
  }

  function isDownloadAction(action) {
    const href = action.href || action.getAttribute("href") || "";
    const actionText = normalizeName(
      [
        action.textContent,
        action.getAttribute("aria-label"),
        action.getAttribute("title"),
        action.getAttribute("data-tooltip"),
      ].filter(Boolean).join(" "),
    );

    if (/(^| )telecharger( |$)/.test(actionText) || /(^| )download( |$)/.test(actionText)) {
      return true;
    }

    if (/\/api\/torrents\/[^/?#]+\/download(?:[/?#]|$)/i.test(href)) {
      return true;
    }

    if (/\/torrents\/[^/?#]+\/download(?:[/?#]|$)/i.test(href)) {
      return true;
    }

    if (/\/download(?:[/?#]|$)/i.test(href) && !/\/user\/downloads(?:[/?#]|$)/i.test(href)) {
      return true;
    }

    return Boolean(action.querySelector(".i-heroicons\\:arrow-down-tray, [class*='i-heroicons:arrow-down-tray']"));
  }

  function maybeSyncAfterRecentDownloadClick() {
    const clickedAt = Number(GM_getValue(RECENT_DOWNLOAD_CLICK_KEY, 0));
    if (!clickedAt) {
      return;
    }

    const ageMs = Date.now() - clickedAt;
    const delayMs = Math.max(0, Number(state.settings.downloadSyncDelayMs) || DEFAULT_SETTINGS.downloadSyncDelayMs);
    if (ageMs > 2 * 60 * 1000) {
      GM_deleteValue(RECENT_DOWNLOAD_CLICK_KEY);
      return;
    }

    scheduleSyncAfterDownloadClick(Math.max(500, delayMs - ageMs));
  }

  function scheduleSyncAfterDownloadClick(delayOverrideMs) {
    const delayMs = Math.max(
      500,
      Number(delayOverrideMs ?? state.settings.downloadSyncDelayMs) || DEFAULT_SETTINGS.downloadSyncDelayMs,
    );

    GM_setValue(RECENT_DOWNLOAD_CLICK_KEY, Date.now());
    window.clearTimeout(state.downloadSyncTimer);
    updateStatus(`Telechargement detecte, sync dans ${Math.ceil(delayMs / 1000)}s...`);

    state.downloadSyncTimer = window.setTimeout(() => {
      syncDownloads({ force: true })
        .then(() => GM_deleteValue(RECENT_DOWNLOAD_CLICK_KEY))
        .catch((error) => {
          console.error("[C411 DL] Synchronisation apres telechargement echouee", error);
          updateStatus(`Erreur sync apres telechargement: ${error.message || error}`);
        });
    }, delayMs);
  }

  function addManualDownloadFromAction(action) {
    const infoHash = extractDownloadHash(action);
    if (!infoHash) {
      return false;
    }

    const release = normalizeRelease({
      infoHash,
      torrentId: null,
      name: findDownloadName(action, infoHash),
      category: null,
      downloadedAt: formatUtcApiDate(new Date()),
      source: "manual",
    });

    if (!release) {
      return false;
    }

    const existingRelease = state.exactByHash.get(infoHash);
    const mergedRelease = existingRelease ? mergeReleases(release, existingRelease) : release;
    const wasKnown = Boolean(existingRelease);
    const releases = state.cache.releases.filter((item) => item.infoHash !== infoHash);
    releases.unshift(mergedRelease);

    state.cache = {
      ...state.cache,
      total: wasKnown ? state.cache.total : Math.max(Number(state.cache.total) || 0, releases.length),
      releases,
    };

    GM_setValue(STORAGE_KEY, state.cache);
    rebuildIndexes();
    queueTorrentDetailFetch(infoHash);
    clearBadges();
    scheduleAnnotate();
    updateStatus("DL ajoute localement");

    return true;
  }

  async function syncDownloads({ force }) {
    if (state.syncInProgress) {
      return;
    }

    if (!force && state.cache.syncedAt && !isCacheStale()) {
      return;
    }

    state.syncInProgress = true;
    updateStatus("Sync en cours...");

    try {
      const perPage = Math.max(1, Number(state.settings.perPage) || DEFAULT_SETTINGS.perPage);
      const maxPages = Math.max(1, Number(state.settings.maxPagesPerSync) || DEFAULT_SETTINGS.maxPagesPerSync);
      const releasesByHash = new Map();
      const sourceTotals = {};
      const sourceFetched = {};
      let totalPages = 0;

      for (const source of PROFILE_SOURCES) {
        try {
          const sourceResult = await syncProfileSource(source, perPage, maxPages, releasesByHash);
          totalPages += sourceResult.totalPages;
          sourceFetched[source.key] = sourceResult.fetched;
          if (Number.isFinite(Number(sourceResult.total))) {
            sourceTotals[source.key] = Number(sourceResult.total);
          }
        } catch (error) {
          if (source.required) {
            throw error;
          }

          console.warn(`[C411 DL] Source ${source.key} ignoree`, error);
        }
      }

      const releases = Array.from(releasesByHash.values());
      state.cache = {
        version: 1,
        syncedAt: new Date().toISOString(),
        total: releases.length,
        totalPages,
        sourceFetched,
        sourceTotals,
        releases,
      };

      GM_setValue(STORAGE_KEY, state.cache);
      rebuildIndexes();
      scheduleMediaEnrichment();
      clearBadges();
      scheduleAnnotate();
      updateStatus(statusSummary());
    } finally {
      state.syncInProgress = false;
      updateStatus(statusSummary());
    }
  }

  async function syncProfileSource(source, perPage, maxPages, releasesByHash) {
    let integrated = 0;
    let total = null;
    let totalPages = 1;

    for (let page = 1; page <= totalPages; page += 1) {
      if (page > maxPages) {
        throw new Error(`limite ${maxPages} pages atteinte pour ${source.label}`);
      }

      updateStatus(`Sync ${source.label} ${page}/${totalPages}...`);
      const payload = await fetchProfilePage(source.path, page, perPage);
      const items = Array.isArray(payload.data) ? payload.data : [];

      for (const item of items) {
        const release = normalizeRelease({ ...item, source: source.key });
        if (release) {
          mergeReleaseIntoMap(releasesByHash, release);
          integrated += 1;
        }
      }

      if (payload.meta && Number.isFinite(Number(payload.meta.totalPages))) {
        totalPages = Math.max(1, Number(payload.meta.totalPages));
      }

      if (payload.meta && Number.isFinite(Number(payload.meta.total))) {
        total = Number(payload.meta.total);
        const effectivePerPage = Number.isFinite(Number(payload.meta.perPage))
          ? Math.max(1, Number(payload.meta.perPage))
          : perPage;
        totalPages = Math.max(totalPages, Math.ceil(total / effectivePerPage));
      }
    }

    if (Number.isFinite(Number(total)) && integrated < Number(total)) {
      throw new Error(`${source.label}: ${integrated}/${total} elements integres`);
    }

    return { fetched: integrated, total, totalPages };
  }

  async function fetchProfilePage(path, page, perPage) {
    const url = new URL(path, window.location.origin);
    url.searchParams.set("page", String(page));
    url.searchParams.set("perPage", String(perPage));

    const response = await fetch(url.toString(), {
      method: "GET",
      credentials: "include",
      headers: {
        accept: "application/json",
      },
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error("reponse API invalide ou session expiree");
    }
  }

  function scheduleMediaEnrichment() {
    const max = Math.max(0, Number(state.settings.maxMediaDetailsPerSync) || DEFAULT_SETTINGS.maxMediaDetailsPerSync);
    let queued = 0;

    for (const release of state.cache.releases) {
      if (queued >= max) {
        break;
      }

      if (queueTorrentDetailFetch(release.infoHash)) {
        queued += 1;
      }
    }
  }

  function queueTorrentDetailFetch(infoHash) {
    const hash = String(infoHash || "").toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(hash) || !needsTorrentDetailFetch(hash) || state.detailQueuedHashes.has(hash)) {
      return false;
    }

    state.detailQueuedHashes.add(hash);
    state.detailQueue.push(hash);
    scheduleDetailQueueProcessing();
    return true;
  }

  function scheduleDetailQueueProcessing() {
    if (state.detailFetchInProgress) {
      return;
    }

    window.clearTimeout(state.detailFetchTimer);
    state.detailFetchTimer = window.setTimeout(() => {
      processDetailQueue().catch((error) => {
        console.error("[C411 DL] Enrichissement media echoue", error);
      });
    }, 250);
  }

  async function processDetailQueue() {
    if (state.detailFetchInProgress || !state.detailQueue.length) {
      return;
    }

    state.detailFetchInProgress = true;
    let updated = false;

    try {
      while (state.detailQueue.length) {
        const hash = state.detailQueue.shift();
        state.detailQueuedHashes.delete(hash);

        if (!needsTorrentDetailFetch(hash)) {
          continue;
        }

        try {
          updateStatus("Enrichissement media...");
          const payload = await fetchTorrentDetail(hash);
          storeTorrentDetail(hash, payload);
          updated = true;
        } catch (error) {
          if (error.status === 404) {
            storeTorrentDetailNotFound(hash);
            updated = true;
          } else {
            console.warn(`[C411 DL] Detail torrent ignore pour ${hash}`, error);
          }
        }
      }
    } finally {
      state.detailFetchInProgress = false;
      if (updated) {
        GM_setValue(DETAILS_KEY, state.detailCache);
        rebuildIndexes();
        clearBadges();
        scheduleAnnotate();
      }
      updateStatus(statusSummary());
    }
  }

  function needsTorrentDetailFetch(infoHash) {
    const detail = state.detailCache.torrents[infoHash];
    if (!detail || !detail.fetchedAt) {
      return true;
    }

    const fetchedAt = Date.parse(detail.fetchedAt);
    if (!fetchedAt) {
      return true;
    }

    const maxAgeMs = Math.max(
      1,
      Number(state.settings.mediaDetailCacheDays) || DEFAULT_SETTINGS.mediaDetailCacheDays,
    ) * 24 * 60 * 60 * 1000;

    return Date.now() - fetchedAt > maxAgeMs;
  }

  async function fetchTorrentDetail(infoHash) {
    const url = new URL(`/api/torrents/${infoHash}`, window.location.origin);
    const response = await fetch(url.toString(), {
      method: "GET",
      credentials: "include",
      headers: {
        accept: "application/json",
      },
    });

    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error("reponse API torrent invalide");
    }
  }

  function storeTorrentDetail(infoHash, payload) {
    const hash = String(payload?.infoHash || infoHash || "").toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(hash)) {
      return null;
    }

    const media = extractMediaInfo(payload);
    const detail = {
      infoHash: hash,
      fetchedAt: new Date().toISOString(),
      mediaKey: media?.mediaKey || "",
      tmdbId: media?.tmdbId ?? null,
      imdbId: media?.imdbId || "",
      mediaType: media?.mediaType || "",
      mediaTitle: media?.mediaTitle || "",
      mediaYear: media?.mediaYear ?? null,
      notFound: false,
    };

    state.detailCache.torrents[hash] = detail;
    return detail;
  }

  function storeTorrentDetailNotFound(infoHash) {
    const hash = String(infoHash || "").toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(hash)) {
      return null;
    }

    const detail = {
      infoHash: hash,
      fetchedAt: new Date().toISOString(),
      mediaKey: "",
      tmdbId: null,
      imdbId: "",
      mediaType: "",
      mediaTitle: "",
      mediaYear: null,
      notFound: true,
    };

    state.detailCache.torrents[hash] = detail;
    return detail;
  }

  function extractMediaInfo(payload) {
    const tmdbData = payload?.metadata?.tmdbData || payload?.tmdbData || null;
    const description = String(payload?.description || "");
    const tmdbFromDescription = description.match(/themoviedb\.org\/(movie|tv)\/(\d+)/i);
    const imdbFromDescription = description.match(/imdb\.com\/title\/(tt\d+)/i);
    const mediaType = String(tmdbData?.type || tmdbFromDescription?.[1] || "").toLowerCase();
    const tmdbId = Number(tmdbData?.id || tmdbFromDescription?.[2] || 0);
    const imdbId = String(tmdbData?.imdbId || imdbFromDescription?.[1] || "").toLowerCase();

    let mediaKey = "";
    if (Number.isFinite(tmdbId) && tmdbId > 0) {
      mediaKey = `tmdb:${mediaType || "unknown"}:${tmdbId}`;
    } else if (/^tt\d+$/.test(imdbId)) {
      mediaKey = `imdb:${imdbId}`;
    }

    if (!mediaKey) {
      return null;
    }

    return {
      mediaKey,
      tmdbId: Number.isFinite(tmdbId) && tmdbId > 0 ? tmdbId : null,
      imdbId,
      mediaType,
      mediaTitle: String(tmdbData?.title || tmdbData?.name || tmdbData?.originalTitle || "").trim(),
      mediaYear: Number.isFinite(Number(tmdbData?.year)) ? Number(tmdbData.year) : null,
    };
  }

  function mediaForHash(infoHash) {
    const detail = detailForHash(infoHash);
    return detail && detail.mediaKey ? detail : null;
  }

  function detailForHash(infoHash) {
    return state.detailCache.torrents[String(infoHash || "").toLowerCase()] || null;
  }

  function mergeReleaseIntoMap(releasesByHash, release) {
    const existing = releasesByHash.get(release.infoHash);
    if (!existing) {
      releasesByHash.set(release.infoHash, release);
      return;
    }

    releasesByHash.set(release.infoHash, mergeReleases(existing, release));
  }

  function mergeReleases(existing, incoming) {
    const sources = Array.from(new Set([
      ...(existing.sources || []),
      ...(incoming.sources || []),
    ]));

    return {
      ...existing,
      torrentId: existing.torrentId ?? incoming.torrentId,
      name: existing.name || incoming.name,
      normalizedKey: existing.normalizedKey || incoming.normalizedKey,
      category: existing.category || incoming.category,
      downloadedAt: existing.downloadedAt || incoming.downloadedAt,
      size: existing.size ?? incoming.size ?? null,
      seedingTime: existing.seedingTime ?? incoming.seedingTime ?? null,
      uploaded: existing.uploaded ?? incoming.uploaded ?? null,
      sources,
    };
  }

  function normalizeCache(cache) {
    if (!cache || typeof cache !== "object") {
      return {
        version: 1,
        syncedAt: null,
        total: 0,
        totalPages: 0,
        sourceFetched: {},
        sourceTotals: {},
        releases: [],
      };
    }

    const releases = Array.isArray(cache.releases)
      ? cache.releases.map(normalizeRelease).filter(Boolean)
      : [];

    return {
      version: 1,
      syncedAt: cache.syncedAt || null,
      total: Number(cache.total) || releases.length,
      totalPages: Number(cache.totalPages) || 0,
      sourceFetched: normalizeSourceTotals(cache.sourceFetched),
      sourceTotals: normalizeSourceTotals(cache.sourceTotals),
      releases,
    };
  }

  function normalizeSourceTotals(sourceTotals) {
    const totals = {};
    if (!sourceTotals || typeof sourceTotals !== "object") {
      return totals;
    }

    for (const [key, value] of Object.entries(sourceTotals)) {
      if (Number.isFinite(Number(value))) {
        totals[key] = Number(value);
      }
    }

    return totals;
  }

  function normalizeDetailCache(cache) {
    const torrents = {};
    if (cache && typeof cache === "object" && cache.torrents && typeof cache.torrents === "object") {
      for (const [hash, detail] of Object.entries(cache.torrents)) {
        const infoHash = String(hash || "").toLowerCase();
        if (!/^[a-f0-9]{40}$/.test(infoHash) || !detail || typeof detail !== "object") {
          continue;
        }

        torrents[infoHash] = {
          infoHash,
          fetchedAt: detail.fetchedAt || null,
          mediaKey: detail.mediaKey || "",
          tmdbId: detail.tmdbId ?? null,
          imdbId: detail.imdbId || "",
          mediaType: detail.mediaType || "",
          mediaTitle: detail.mediaTitle || "",
          mediaYear: detail.mediaYear ?? null,
          notFound: Boolean(detail.notFound),
        };
      }
    }

    return {
      version: 1,
      torrents,
    };
  }

  function normalizeRelease(item) {
    if (!item || typeof item !== "object") {
      return null;
    }

    const torrent = item.torrent && typeof item.torrent === "object" ? item.torrent : {};
    const infoHash = String(
      item.infoHash
        || item.info_hash
        || item.hash
        || torrent.infoHash
        || torrent.info_hash
        || torrent.hash
        || "",
    ).toLowerCase();

    if (!/^[a-f0-9]{40}$/.test(infoHash)) {
      return null;
    }

    const name = String(item.name || item.torrentName || item.torrent_name || torrent.name || "").trim();
    const key = buildContentKey(name);
    const category = item.category || torrent.category || {};
    const sources = Array.isArray(item.sources)
      ? item.sources.map((source) => String(source)).filter(Boolean)
      : [item.source ? String(item.source) : ""].filter(Boolean);

    return {
      infoHash,
      torrentId: item.torrentId ?? item.torrent_id ?? torrent.id ?? null,
      name,
      normalizedKey: key,
      category: category && category.name ? String(category.name) : "",
      downloadedAt: item.downloadedAt || item.downloaded_at || item.completedAt || item.completed_at || "",
      size: Number.isFinite(Number(item.size)) ? Number(item.size) : null,
      seedingTime: Number.isFinite(Number(item.seedingTime)) ? Number(item.seedingTime) : null,
      uploaded: Number.isFinite(Number(item.uploaded)) ? Number(item.uploaded) : null,
      mediaKey: item.mediaKey || "",
      sources,
    };
  }

  function rebuildIndexes() {
    state.exactByHash = new Map();
    state.altByKey = new Map();
    state.mediaByHash = new Map();
    state.altByMediaKey = new Map();

    for (const release of state.cache.releases) {
      state.exactByHash.set(release.infoHash, release);

      const media = mediaForHash(release.infoHash);
      if (media && media.mediaKey) {
        state.mediaByHash.set(release.infoHash, media);
        const mediaMatches = state.altByMediaKey.get(media.mediaKey) || [];
        mediaMatches.push(release);
        state.altByMediaKey.set(media.mediaKey, mediaMatches);
      }

      if (release.normalizedKey) {
        const matches = state.altByKey.get(release.normalizedKey) || [];
        matches.push(release);
        state.altByKey.set(release.normalizedKey, matches);
      }
    }
  }

  function observePageChanges() {
    const observer = new MutationObserver(() => scheduleAnnotate());
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function scheduleAnnotate() {
    window.clearTimeout(state.annotateTimer);
    state.annotateTimer = window.setTimeout(annotateTorrentLinks, 120);
  }

  function annotateTorrentLinks() {
    const links = document.querySelectorAll('a[href*="/torrents/"]');

    for (const link of links) {
      if (link.dataset.c411DlProcessed === "1") {
        continue;
      }

      const hash = extractHash(link.href);
      if (!hash) {
        continue;
      }

      const exactRelease = state.exactByHash.get(hash);
      if (exactRelease) {
        const titleInfo = findTitleInfo(link) || findRowPlacement(link);
        if (!titleInfo) {
          link.dataset.c411DlProcessed = "1";
          continue;
        }

        addBadge(link, titleInfo, {
          type: "exact",
          label: "DL",
          title: exactTooltip(exactRelease),
        });

        if (isActiveSeedRelease(exactRelease)) {
          addBadge(link, titleInfo, {
            type: "seed",
            label: "Seed",
            title: seedTooltip(exactRelease),
            extraClass: seedRatioClass(exactRelease),
          });
        }

        if (!mediaForHash(hash)) {
          queueTorrentDetailFetch(hash);
        }
        continue;
      }

      if (state.settings.showAltBadge) {
        const titleInfo = findTitleInfo(link);
        if (!titleInfo || !titleInfo.title) {
          link.dataset.c411DlProcessed = "1";
          continue;
        }

        const detail = detailForHash(hash);
        const media = detail && detail.mediaKey ? detail : null;
        const altMatches = media && media.mediaKey
          ? (state.altByMediaKey.get(media.mediaKey) || []).filter((release) => release.infoHash !== hash)
          : [];

        if (altMatches.length) {
          addBadge(link, titleInfo, {
            type: "alt",
            label: "ALT ✓",
            title: altTooltip(altMatches, media),
          });
        } else if (!detail || !detail.fetchedAt) {
          queueTorrentDetailFetch(hash);
        } else if (!media || !media.mediaKey) {
          if (needsTorrentDetailFetch(hash)) {
            queueTorrentDetailFetch(hash);
          }

          const fallbackMatches = findFallbackAltMatches(hash, titleInfo.title);
          if (fallbackMatches.length) {
            addBadge(link, titleInfo, {
              type: "alt",
              label: "ALT!",
              title: altTooltip(fallbackMatches, null),
            });
          }
        }
      }

      link.dataset.c411DlProcessed = "1";
    }
  }

  function findFallbackAltMatches(infoHash, title) {
    const key = buildContentKey(title);
    return key ? (state.altByKey.get(key) || []).filter((release) => release.infoHash !== infoHash) : [];
  }

  function clearBadges() {
    for (const badge of document.querySelectorAll(".c411-dl-badge")) {
      badge.remove();
    }

    for (const link of document.querySelectorAll("[data-c411-dl-processed]")) {
      delete link.dataset.c411DlProcessed;
    }
  }

  function extractHash(url) {
    const match = String(url || "").match(HASH_RE);
    return match ? match[1].toLowerCase() : "";
  }

  function findDefaultDebugHash() {
    return extractHash(window.location.href)
      || extractHash(document.querySelector('a[href*="/torrents/"]')?.href)
      || "";
  }

  async function debugTorrentApi(value) {
    const infoHash = extractHash(value) || String(value || "").trim().toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(infoHash)) {
      throw new Error("infoHash invalide");
    }

    updateStatus("Debug API torrent...");
    const url = new URL(`/api/torrents/${infoHash}`, window.location.origin);
    const response = await fetch(url.toString(), {
      method: "GET",
      credentials: "include",
      headers: {
        accept: "application/json",
      },
    });

    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      // Keep the raw body visible below when the endpoint returns HTML or an invalid JSON payload.
    }

    console.group(`[C411 DL] Debug API torrent ${infoHash}`);
    console.log("URL", url.toString());
    console.log("HTTP", response.status, response.statusText);
    console.log("JSON", payload);
    console.log("JSON string", payload ? JSON.stringify(payload, null, 2) : null);
    console.log("Raw", text);
    console.groupEnd();

    if (response.status === 404) {
      storeTorrentDetailNotFound(infoHash);
      GM_setValue(DETAILS_KEY, state.detailCache);
      rebuildIndexes();
      clearBadges();
      scheduleAnnotate();
    } else if (payload) {
      storeTorrentDetail(infoHash, payload);
      GM_setValue(DETAILS_KEY, state.detailCache);
      rebuildIndexes();
      clearBadges();
      scheduleAnnotate();
    }

    updateStatus(`Debug API: HTTP ${response.status}, voir console`);
    return payload || text;
  }

  function extractDownloadHash(action) {
    const urls = [
      action.href,
      action.getAttribute("href"),
      findTorrentLinkForAction(action, "")?.href,
      window.location.href,
    ];

    for (const url of urls) {
      const hash = extractHash(url);
      if (hash) {
        return hash;
      }
    }

    return "";
  }

  function findDownloadName(action, infoHash) {
    const torrentLink = findTorrentLinkForAction(action, infoHash);
    const titleInfo = torrentLink ? findTitleInfo(torrentLink) : null;
    if (titleInfo?.title) {
      return titleInfo.title;
    }

    const pageTitle = cleanText(document.querySelector("h1")?.textContent);
    if (pageTitle.length > 2) {
      return pageTitle;
    }

    const documentTitle = cleanText(document.title).replace(/\s*[-|]\s*C411.*$/i, "");
    if (documentTitle.length > 2) {
      return documentTitle;
    }

    return `Torrent ${infoHash.slice(0, 8)}`;
  }

  function findTorrentLinkForAction(action, infoHash) {
    const hashSelector = infoHash ? `a[href*="${infoHash}"]` : 'a[href*="/torrents/"]';
    const directLink = action.matches?.('a[href*="/torrents/"]') ? action : null;
    if (directLink) {
      return directLink;
    }

    const parentLink = action.closest?.('a[href*="/torrents/"]');
    if (parentLink) {
      return parentLink;
    }

    const container = action.closest?.("tr, li, article, section, [class*='group'], [class*='border']");
    const scopedLink = container?.querySelector(hashSelector);
    if (scopedLink) {
      return scopedLink;
    }

    return infoHash ? document.querySelector(hashSelector) : null;
  }

  function findTitleInfo(link) {
    const rowPlacement = findRowPlacement(link);
    if (rowPlacement) {
      return null;
    }

    const desktopTitle = link.querySelector("span.truncate.font-medium");
    if (desktopTitle && cleanText(desktopTitle.textContent).length > 2) {
      return {
        title: cleanText(desktopTitle.textContent),
        target: desktopTitle,
        mode: "after-target",
      };
    }

    const mobileTitle = link.querySelector("p.font-medium");
    if (mobileTitle && cleanText(mobileTitle.textContent).length > 2) {
      return {
        title: cleanText(mobileTitle.textContent),
        target: mobileTitle,
        mode: "append-target",
      };
    }

    const directText = cleanText(link.textContent);
    if (directText.length > 2 && link.children.length <= 1) {
      return {
        title: directText,
        target: link,
        mode: "after-target",
      };
    }

    if (directText.length > 2 && link.matches(".font-medium")) {
      return {
        title: directText,
        target: link,
        mode: "after-target",
      };
    }

    return null;
  }

  function findRowPlacement(link) {
    const firstChild = link.firstElementChild;
    if (!firstChild || !firstChild.className || !String(firstChild.className).includes("border-l-")) {
      return null;
    }

    const row = firstChild.querySelector(".flex.items-center");
    if (!row || !row.querySelector(".flex-1")) {
      return null;
    }

    return {
      title: "",
      target: row,
      mode: "version-row",
    };
  }

  function addBadge(link, titleInfo, badgeInfo) {
    if (link.querySelector(`.c411-dl-badge--${badgeInfo.type}`)) {
      link.dataset.c411DlProcessed = "1";
      return;
    }

    const badge = document.createElement("span");
    badge.className = `c411-dl-badge c411-dl-badge--${badgeInfo.type}`;
    if (badgeInfo.extraClass) {
      badge.classList.add(badgeInfo.extraClass);
    }
    badge.textContent = badgeInfo.label;
    badge.title = badgeInfo.title;

    const target = titleInfo.target;
    if (titleInfo.mode === "append-target") {
      if (!target.querySelector(".c411-dl-badge")) {
        target.appendChild(document.createTextNode(" "));
      }
      target.appendChild(badge);
    } else if (titleInfo.mode === "version-row") {
      badge.classList.add("c411-dl-badge--row");
      const spacer = target.querySelector(".flex-1");
      target.insertBefore(badge, spacer || null);
    } else if (target.parentElement && target.parentElement.classList.contains("flex")) {
      insertAfterLastBadge(target, badge);
    } else {
      insertAfterLastBadge(target, badge);
    }

    link.dataset.c411DlProcessed = "1";
  }

  function insertAfterLastBadge(target, badge) {
    let anchor = target;
    let next = target.nextElementSibling;
    while (next && next.classList.contains("c411-dl-badge")) {
      anchor = next;
      next = next.nextElementSibling;
    }

    anchor.insertAdjacentElement("afterend", badge);
  }

  function exactTooltip(release) {
    const parts = ["Torrent exact deja telecharge"];
    if (release.downloadedAt) {
      parts.push(`le ${formatDownloadedAt(release.downloadedAt)}`);
    }
    if (release.name) {
      parts.push(release.name);
    }
    return parts.join("\n");
  }

  function seedTooltip(release) {
    const parts = ["Seed actif"];
    const ratio = seedRatio(release);
    if (ratio !== null) {
      parts.push(`ratio ${formatRatio(ratio)}`);
    }
    if (Number.isFinite(Number(release.seedingTime))) {
      parts.push(`depuis ${formatDuration(Number(release.seedingTime))}`);
    }
    if (Number.isFinite(Number(release.uploaded))) {
      parts.push(`upload ${formatBytes(Number(release.uploaded))}`);
    }
    if (release.name) {
      parts.push(release.name);
    }
    return parts.join("\n");
  }

  function isActiveSeedRelease(release) {
    return Array.isArray(release.sources) && release.sources.includes("active-seeds");
  }

  function seedRatio(release) {
    const uploaded = Number(release.uploaded);
    const size = Number(release.size);
    if (!Number.isFinite(uploaded) || !Number.isFinite(size) || size <= 0) {
      return null;
    }

    return uploaded / size;
  }

  function seedRatioClass(release) {
    const ratio = seedRatio(release);
    if (ratio === null) {
      return "";
    }

    if (ratio < 1) {
      return "c411-dl-badge--seed-ratio-low";
    }

    if (ratio < 2) {
      return "c411-dl-badge--seed-ratio-warn";
    }

    if (ratio < 3) {
      return "c411-dl-badge--seed-ratio-mid";
    }

    if (ratio < 4) {
      return "c411-dl-badge--seed-ratio-good";
    }

    if (ratio < 5) {
      return "c411-dl-badge--seed-ratio-ok";
    }

    return "";
  }

  function formatRatio(value) {
    if (value < 10) {
      return value.toFixed(2);
    }

    return value.toFixed(1);
  }

  function altTooltip(matches, media) {
    const lines = [`Autre release deja telechargee (${matches.length})`];
    if (media?.mediaTitle || media?.mediaKey) {
      const year = media.mediaYear ? ` (${media.mediaYear})` : "";
      lines.push(`${media.mediaTitle || media.mediaKey}${year}`);
    }
    for (const match of matches.slice(0, 3)) {
      const date = match.downloadedAt ? ` - ${formatDownloadedAt(match.downloadedAt)}` : "";
      lines.push(`${match.name}${date}`);
    }
    if (matches.length > 3) {
      lines.push(`... +${matches.length - 3}`);
    }
    return lines.join("\n");
  }

  function buildContentKey(name) {
    const cleaned = normalizeName(name);
    if (!cleaned) {
      return "";
    }

    const tokens = cleaned
      .split(" ")
      .map((token) => token.trim())
      .filter(Boolean)
      .filter((token) => !isTechnicalToken(token));

    if (tokens.length < 2) {
      return "";
    }

    const seasonIndex = tokens.findIndex((token) => /^s\d{1,2}(e\d{1,3})?$/.test(token));
    if (seasonIndex > 0) {
      return compactKey(tokens.slice(0, seasonIndex + 1));
    }

    const yearIndex = tokens.findIndex((token) => /^(19|20)\d{2}$/.test(token));
    if (yearIndex > 0) {
      return compactKey(tokens.slice(0, yearIndex + 1));
    }

    const usefulTokens = stripLikelyReleaseGroup(tokens);
    if (usefulTokens.length < 3) {
      return "";
    }

    return compactKey(usefulTokens.slice(0, 8));
  }

  function normalizeName(name) {
    return String(name || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/['\u2019]/g, "")
      .replace(/\b(\d{3,4})p\b/g, " $1p ")
      .replace(/\bweb[-_. ]?dl\b/g, " webdl ")
      .replace(/\bh\.?264\b/g, " h264 ")
      .replace(/\bh\.?265\b/g, " h265 ")
      .replace(/\bx\.?264\b/g, " x264 ")
      .replace(/\bx\.?265\b/g, " x265 ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isTechnicalToken(token) {
    if (TECHNICAL_TOKENS.has(token)) {
      return true;
    }

    if (/^\d{3,4}p$/.test(token)) {
      return true;
    }

    if (/^\d+(bit|bits|fps|hz|khz|mbps|kbps)$/.test(token)) {
      return true;
    }

    if (/^\d+ch$/.test(token)) {
      return true;
    }

    return false;
  }

  function stripLikelyReleaseGroup(tokens) {
    if (tokens.length <= 3) {
      return tokens;
    }

    const copy = tokens.slice();
    const last = copy[copy.length - 1];
    if (/^[a-z]{2,12}\d{0,4}$/.test(last) && !/^(19|20)\d{2}$/.test(last)) {
      copy.pop();
    }

    return copy;
  }

  function compactKey(tokens) {
    const key = tokens.join(" ").trim();
    return key.length >= 8 ? key : "";
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function formatDate(date) {
    return date.toLocaleString("fr-FR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function formatDuration(seconds) {
    const units = [
      ["j", 24 * 60 * 60],
      ["h", 60 * 60],
      ["min", 60],
    ];
    const parts = [];
    let remaining = Math.max(0, Math.floor(seconds));

    for (const [label, size] of units) {
      const value = Math.floor(remaining / size);
      if (value) {
        parts.push(`${value} ${label}`);
        remaining -= value * size;
      }
      if (parts.length >= 2) {
        break;
      }
    }

    return parts.length ? parts.join(" ") : `${remaining} s`;
  }

  function formatBytes(bytes) {
    const units = ["o", "Ko", "Mo", "Go", "To"];
    let value = Math.max(0, bytes);
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }

    const rounded = value >= 10 || unitIndex === 0 ? Math.round(value) : Math.round(value * 10) / 10;
    return `${rounded} ${units[unitIndex]}`;
  }

  function formatDownloadedAt(value) {
    const parsedDate = parseApiUtcDate(value);
    if (!parsedDate) {
      return value;
    }

    return parsedDate.toLocaleString("fr-FR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function formatUtcApiDate(date) {
    const pad = (value) => String(value).padStart(2, "0");

    return [
      date.getUTCFullYear(),
      pad(date.getUTCMonth() + 1),
      pad(date.getUTCDate()),
    ].join("-") + " " + [
      pad(date.getUTCHours()),
      pad(date.getUTCMinutes()),
      pad(date.getUTCSeconds()),
    ].join(":");
  }

  function parseApiUtcDate(value) {
    const match = String(value || "").match(
      /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/,
    );

    if (!match) {
      return null;
    }

    const [, year, month, day, hour, minute, second = "0"] = match;
    const timestamp = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    );

    return Number.isNaN(timestamp) ? null : new Date(timestamp);
  }
})();
