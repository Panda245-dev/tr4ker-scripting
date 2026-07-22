// ==UserScript==
// @name         TR4KER - Pastilles torrents telecharges
// @namespace    https://tr4ker.net/
// @version      1.0.0
// @description  Marque les torrents deja telecharges sur TR4KER avec des pastilles DL et SEED.
// @author       panda245 (base: Butchered/C411)
// @icon         https://tr4ker.net/favicon.ico
// @match        https://tr4ker.net/*
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

  const STORAGE_KEY = "tr4kerDownloadedBadges.cache.v1";
  const DETAILS_KEY = "tr4kerDownloadedBadges.details.v1";
  const SETTINGS_KEY = "tr4kerDownloadedBadges.settings.v1";
  const RECENT_DOWNLOAD_CLICK_KEY = "tr4kerDownloadedBadges.recentDownloadClick.v1";

  // /torrent/<slug> (singulier, pas /torrents/)
  const SLUG_RE = /\/torrent\/([a-z0-9][a-z0-9-]{2,300})(?:[/?#]|$)/i;
  // /api/torrents/<slug>/download  →  lien de téléchargement du .torrent (href DOM, pas un endpoint JSON)
  const DOWNLOAD_URL_RE = /\/api\/torrents\/([a-z0-9][a-z0-9-]{2,300})\/download(?:[/?#]|$)/i;

  const DOWNLOAD_API_PATH = "/api/me/downloads";
  const DOWNLOAD_PAGE_LIMIT = 100; // max accepté par l'API TR4KER

  const DEFAULT_SETTINGS = {
    autoSyncHours: 1,
    downloadSyncDelayMs: 4000,
    showAltBadge: true,
    mediaDetailCacheDays: 300,
    maxMediaDetailsPerSync: 300,
  };

  const TECHNICAL_TOKENS = new Set([
    "aac", "ac3", "ad", "atmos", "av1", "avc", "bdrip", "bluray", "br", "brrip",
    "custom", "dc", "ddp", "dl", "dolby", "dts", "dv", "dvd", "dvdrip", "eac3",
    "flac", "fr", "french", "full", "h264", "h265", "hdr", "hdr10", "hdr10plus",
    "hdlight", "hevc", "imax", "light", "ma", "multi", "multilang", "proper",
    "pq10", "remaster", "remastered", "remux", "rip", "sdr", "theatrical",
    "truefrench", "truehd", "uhd", "vf", "vf2", "vff", "vfq", "vo", "vof",
    "vost", "vostfr", "web", "webdl", "webrip", "x264", "x265", "xvid",
  ]);

  const state = {
    cache: normalizeCache(GM_getValue(STORAGE_KEY, null)),
    detailCache: normalizeDetailCache(GM_getValue(DETAILS_KEY, null)),
    settings: { ...DEFAULT_SETTINGS, ...GM_getValue(SETTINGS_KEY, {}) },
    exactBySlug: new Map(),
    altByKey: new Map(),
    mediaBySlug: new Map(),
    altByMediaKey: new Map(),
    syncInProgress: false,
    annotateTimer: null,
    downloadSyncTimer: null,
    detailFetchInProgress: false,
    detailFetchTimer: null,
    detailQueue: [],
    detailQueuedSlugs: new Set(),
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

  // ─── Styles ────────────────────────────────────────────────────────────────

  function addStyles() {
    GM_addStyle(`
      .tr4ker-dl-badge {
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
      .tr4ker-dl-badge--exact {
        color: #052e16; background: #86efac; border-color: #22c55e;
      }
      [data-theme="dark"] .tr4ker-dl-badge--exact {
        color: #dcfce7; background: rgba(34,197,94,.22); border-color: rgba(74,222,128,.75);
      }
      .tr4ker-dl-badge--alt {
        color: #431407; background: #fdba74; border-color: #f97316;
      }
      [data-theme="dark"] .tr4ker-dl-badge--alt {
        color: #ffedd5; background: rgba(249,115,22,.22); border-color: rgba(251,146,60,.8);
      }
      .tr4ker-dl-badge--seed {
        color: #172554; background: #93c5fd; border-color: #3b82f6;
      }
      [data-theme="dark"] .tr4ker-dl-badge--seed {
        color: #dbeafe; background: rgba(59,130,246,.22); border-color: rgba(96,165,250,.8);
      }
      .tr4ker-dl-badge--seed-ratio-low {
        color: #450a0a; background: #fca5a5; border-color: #ef4444;
      }
      [data-theme="dark"] .tr4ker-dl-badge--seed-ratio-low {
        color: #fee2e2; background: rgba(239,68,68,.24); border-color: rgba(248,113,113,.85);
      }
      .tr4ker-dl-badge--seed-ratio-warn {
        color: #431407; background: #fdba74; border-color: #f97316;
      }
      [data-theme="dark"] .tr4ker-dl-badge--seed-ratio-warn {
        color: #ffedd5; background: rgba(249,115,22,.24); border-color: rgba(251,146,60,.85);
      }
      .tr4ker-dl-badge--seed-ratio-mid {
        color: #422006; background: #fde68a; border-color: #eab308;
      }
      [data-theme="dark"] .tr4ker-dl-badge--seed-ratio-mid {
        color: #fef9c3; background: rgba(234,179,8,.24); border-color: rgba(250,204,21,.85);
      }
      .tr4ker-dl-badge--seed-ratio-good {
        color: #052e16; background: #86efac; border-color: #22c55e;
      }
      [data-theme="dark"] .tr4ker-dl-badge--seed-ratio-good {
        color: #dcfce7; background: rgba(34,197,94,.24); border-color: rgba(74,222,128,.85);
      }
      .tr4ker-dl-badge--seed-ratio-ok {
        color: #083344; background: #67e8f9; border-color: #06b6d4;
      }
      [data-theme="dark"] .tr4ker-dl-badge--seed-ratio-ok {
        color: #cffafe; background: rgba(6,182,212,.24); border-color: rgba(34,211,238,.85);
      }
      .tr4ker-dl-status {
        position: fixed;
        right: 14px; bottom: 14px; z-index: 99998;
        display: flex; align-items: center; gap: 8px;
        max-width: min(360px, calc(100vw - 28px));
        padding: 8px 10px; border-radius: 8px;
        border: 1px solid rgba(16,185,129,.35);
        background: rgba(15,23,42,.92); color: #ecfdf5;
        font: 12px/1.25 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        box-shadow: 0 8px 24px rgba(0,0,0,.28);
      }
      .tr4ker-dl-status__button {
        appearance: none;
        border: 1px solid rgba(110,231,183,.55); border-radius: 6px;
        background: rgba(16,185,129,.18); color: inherit;
        cursor: pointer; font: inherit; font-weight: 700; padding: 4px 7px;
      }
      .tr4ker-dl-status__button:hover { background: rgba(16,185,129,.3); }
      .tr4ker-dl-status__button:disabled { cursor: wait; opacity: .7; }
      @media (max-width: 640px) {
        .tr4ker-dl-status { right: 8px; bottom: 8px; font-size: 11px; }
      }
    `);
  }

  // ─── Menu ──────────────────────────────────────────────────────────────────

  function registerMenu() {
    GM_registerMenuCommand("TR4KER DL - Synchroniser maintenant", () => {
      syncDownloads({ force: true });
    });

    GM_registerMenuCommand("TR4KER DL - Vider le cache", () => {
      GM_deleteValue(STORAGE_KEY);
      GM_deleteValue(DETAILS_KEY);
      state.cache = normalizeCache(null);
      state.detailCache = normalizeDetailCache(null);
      rebuildIndexes();
      clearBadges();
      scheduleAnnotate();
      updateStatus("Cache vide");
    });

    GM_registerMenuCommand("TR4KER DL - Debug API torrent", () => {
      const defaultSlug = findDefaultDebugSlug();
      const input = window.prompt("Slug a tester avec /api/torrents/<slug>", defaultSlug);
      if (!input) return;
      debugTorrentApi(input.trim()).catch((err) => {
        console.error("[TR4KER DL] Debug API echoue", err);
        updateStatus(`Debug API echoue: ${err.message || err}`);
      });
    });
  }

  function exposeDebugHelpers() {
    const target = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    target.tr4kerDlDebugTorrent = (slug) => debugTorrentApi(slug || findDefaultDebugSlug());
    target.tr4kerDlState = state;
  }

  // ─── Status widget ─────────────────────────────────────────────────────────

  function renderStatusWidget() {
    const el = document.createElement("div");
    el.className = "tr4ker-dl-status";

    const text = document.createElement("span");
    text.className = "tr4ker-dl-status__text";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "tr4ker-dl-status__button";
    button.textContent = "Sync";
    button.addEventListener("click", () => syncDownloads({ force: true }));

    el.append(text, button);
    document.body.appendChild(el);
    state.statusEl = el;
    updateStatus(statusSummary());
  }

  function statusSummary() {
    const count = state.cache.releases.length;
    if (!count) return "DL: non synchronise";
    const activeSeeds = state.cache.releases.filter(isActiveSeedRelease).length;
    const date = state.cache.syncedAt ? new Date(state.cache.syncedAt) : null;
    const synced = date && !isNaN(date) ? formatDate(date) : "date inconnue";
    return `DL: ${count} torrents, seeds: ${activeSeeds}, sync ${synced}`;
  }

  function updateStatus(message) {
    if (!state.statusEl) return;
    state.statusEl.querySelector(".tr4ker-dl-status__text").textContent = message;
    state.statusEl.querySelector(".tr4ker-dl-status__button").disabled = state.syncInProgress;
  }

  // ─── Auto-sync ─────────────────────────────────────────────────────────────

  async function maybeAutoSync() {
    if (state.syncInProgress) return;
    const isEmpty = state.cache.releases.length === 0;
    if (isEmpty || !state.cache.syncedAt || isCacheStale()) {
      await syncDownloads({ force: isEmpty });
    }
  }

  function isCacheStale() {
    const syncedAt = Date.parse(state.cache.syncedAt || "");
    if (!syncedAt) return true;
    return Date.now() - syncedAt > state.settings.autoSyncHours * 3600 * 1000;
  }

  // ─── Download click detection ──────────────────────────────────────────────

  function observeDownloadClicks() {
    document.addEventListener("click", (event) => {
      const action = event.target?.closest?.("a, button, [role='button']");
      if (!action || state.statusEl?.contains(action)) return;
      if (isDownloadAction(action)) {
        addManualDownloadFromAction(action);
        scheduleSyncAfterDownloadClick();
      }
    }, true);
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

    // Lien de téléchargement du .torrent : /api/torrents/<slug>/download
    if (DOWNLOAD_URL_RE.test(href)) return true;

    // Icône Material Symbols "download"
    const icon = action.querySelector(".material-symbols-outlined");
    if (icon && icon.textContent.trim() === "download") return true;

    return false;
  }

  function maybeSyncAfterRecentDownloadClick() {
    const clickedAt = Number(GM_getValue(RECENT_DOWNLOAD_CLICK_KEY, 0));
    if (!clickedAt) return;
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
      syncDownloads({ force: true }).then(() => GM_deleteValue(RECENT_DOWNLOAD_CLICK_KEY));
    }, delayMs);
  }

  function addManualDownloadFromAction(action) {
    const slug = extractDownloadSlug(action);
    if (!slug) return false;

    const release = normalizeRelease({
      slug,
      name: findDownloadName(action, slug),
      cat_name: "",
      first_seen_at: new Date().toISOString(),
      size_bytes: null,
      seedtime_seconds: 0,
      uploaded: 0,
      is_completed: false,
    });

    if (!release) return false;

    const existing = state.exactBySlug.get(slug);
    const merged = existing ? mergeReleases(existing, release) : release;
    const releases = state.cache.releases.filter((r) => r.slug !== slug);
    releases.unshift(merged);

    state.cache = {
      ...state.cache,
      total: existing ? state.cache.total : Math.max(Number(state.cache.total) || 0, releases.length),
      releases,
    };

    GM_setValue(STORAGE_KEY, state.cache);
    rebuildIndexes();
    queueTorrentDetailFetch(slug);
    clearBadges();
    scheduleAnnotate();
    updateStatus("DL ajoute localement");
    return true;
  }

  // ─── Sync ──────────────────────────────────────────────────────────────────

  async function syncDownloads({ force }) {
    if (state.syncInProgress) return;
    if (!force && state.cache.syncedAt && !isCacheStale()) return;

    state.syncInProgress = true;
    updateStatus("Sync en cours...");

    try {
      const items = await fetchAllDownloads();

      const releasesBySlug = new Map();
      for (const item of items) {
        const release = normalizeRelease(item);
        if (release) releasesBySlug.set(release.slug, release);
      }

      const releases = Array.from(releasesBySlug.values());
      state.cache = {
        version: 1,
        syncedAt: new Date().toISOString(),
        total: releases.length,
        releases,
      };

      GM_setValue(STORAGE_KEY, state.cache);
      rebuildIndexes();
      scheduleMediaEnrichment();
      clearBadges();
      scheduleAnnotate();
    } catch (err) {
      console.error("[TR4KER DL] Sync echouee:", err);
      updateStatus(`Erreur sync: ${err.message || err}`);
      return;
    } finally {
      state.syncInProgress = false;
    }

    updateStatus(statusSummary());
  }

  async function fetchAllDownloads() {
    const allItems = [];
    let page = 1;
    let totalPages = 1;

    do {
      const url = new URL(DOWNLOAD_API_PATH, window.location.origin);
      url.searchParams.set("limit", String(DOWNLOAD_PAGE_LIMIT));
      url.searchParams.set("filter", "all");
      url.searchParams.set("page", String(page));

      updateStatus(`Sync telechargements page ${page}/${totalPages}...`);

      const response = await fetch(url.toString(), {
        method: "GET",
        credentials: "include",
        headers: { accept: "application/json" },
      });

      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error("reponse non-JSON (session expiree ?)");
      }

      const items = Array.isArray(data) ? data
        : Array.isArray(data.items) ? data.items
        : Array.isArray(data.data) ? data.data
        : Array.isArray(data.downloads) ? data.downloads
        : [];

      allItems.push(...items);

      // Mise à jour du nombre de pages depuis la réponse
      if (data.total_pages) {
        totalPages = Number(data.total_pages);
      } else if (data.total && data.limit) {
        totalPages = Math.ceil(data.total / data.limit);
      }

      page++;
    } while (page <= totalPages);

    return allItems;
  }

  // ─── Media enrichment (badges ALT) ────────────────────────────────────────

  function scheduleMediaEnrichment() {
    const max = Math.max(0, Number(state.settings.maxMediaDetailsPerSync) || DEFAULT_SETTINGS.maxMediaDetailsPerSync);
    let queued = 0;
    for (const release of state.cache.releases) {
      if (queued >= max) break;
      if (queueTorrentDetailFetch(release.slug)) queued++;
    }
  }

  function queueTorrentDetailFetch(slug) {
    const s = String(slug || "").toLowerCase();
    if (!isValidSlug(s) || !needsTorrentDetailFetch(s) || state.detailQueuedSlugs.has(s)) {
      return false;
    }
    state.detailQueuedSlugs.add(s);
    state.detailQueue.push(s);
    scheduleDetailQueueProcessing();
    return true;
  }

  function scheduleDetailQueueProcessing() {
    if (state.detailFetchInProgress) return;
    window.clearTimeout(state.detailFetchTimer);
    state.detailFetchTimer = window.setTimeout(() => {
      processDetailQueue().catch((err) => {
        console.error("[TR4KER DL] Enrichissement media echoue", err);
      });
    }, 250);
  }

  async function processDetailQueue() {
    if (state.detailFetchInProgress || !state.detailQueue.length) return;
    state.detailFetchInProgress = true;
    let updated = false;

    try {
      while (state.detailQueue.length) {
        const slug = state.detailQueue.shift();
        state.detailQueuedSlugs.delete(slug);
        if (!needsTorrentDetailFetch(slug)) continue;

        try {
          updateStatus("Enrichissement media...");
          const payload = await fetchTorrentDetail(slug);
          storeTorrentDetail(slug, payload);
          updated = true;
        } catch (err) {
          if (err.status === 404) {
            storeTorrentDetailNotFound(slug);
            updated = true;
          } else {
            console.warn(`[TR4KER DL] Detail torrent ignore pour ${slug}`, err);
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

  function needsTorrentDetailFetch(slug) {
    const detail = state.detailCache.torrents[slug];
    if (!detail?.fetchedAt) return true;
    const fetchedAt = Date.parse(detail.fetchedAt);
    if (!fetchedAt) return true;
    const maxAgeMs = Math.max(
      1,
      Number(state.settings.mediaDetailCacheDays) || DEFAULT_SETTINGS.mediaDetailCacheDays,
    ) * 86400 * 1000;
    return Date.now() - fetchedAt > maxAgeMs;
  }

  async function fetchTorrentDetail(slug) {
    const url = new URL(`/api/torrents/${slug}`, window.location.origin);
    const response = await fetch(url.toString(), {
      method: "GET",
      credentials: "include",
      headers: { accept: "application/json" },
    });
    const text = await response.text();
    if (!response.ok) {
      const err = new Error(`HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("reponse API torrent invalide");
    }
  }

  function storeTorrentDetail(slug, payload) {
    const s = String(slug || "").toLowerCase();
    if (!isValidSlug(s)) return null;
    const media = extractMediaInfo(payload);
    state.detailCache.torrents[s] = {
      slug: s,
      fetchedAt: new Date().toISOString(),
      mediaKey: media?.mediaKey || "",
      tmdbId: media?.tmdbId ?? null,
      imdbId: media?.imdbId || "",
      mediaType: media?.mediaType || "",
      mediaTitle: media?.mediaTitle || "",
      mediaYear: media?.mediaYear ?? null,
      notFound: false,
    };
    return state.detailCache.torrents[s];
  }

  function storeTorrentDetailNotFound(slug) {
    const s = String(slug || "").toLowerCase();
    if (!isValidSlug(s)) return;
    state.detailCache.torrents[s] = {
      slug: s, fetchedAt: new Date().toISOString(),
      mediaKey: "", tmdbId: null, imdbId: "",
      mediaType: "", mediaTitle: "", mediaYear: null,
      notFound: true,
    };
  }

  function extractMediaInfo(payload) {
    // TR4KER expose les IDs directement : tmdb_id, imdb_id, tvdb_id
    // tmdb_type est parfois null → on l'exclut de la mediaKey pour éviter
    // les mismatches "tmdb:unknown:9737" vs "tmdb:movie:9737"
    const tmdbId = Number(payload?.tmdb_id || 0);
    const imdbId = String(payload?.imdb_id || "").toLowerCase();
    const tvdbId = Number(payload?.tvdb_id || 0);

    let mediaKey = "";
    if (Number.isFinite(tmdbId) && tmdbId > 0) {
      mediaKey = `tmdb:${tmdbId}`;
    } else if (/^tt\d+$/.test(imdbId)) {
      mediaKey = `imdb:${imdbId}`;
    } else if (Number.isFinite(tvdbId) && tvdbId > 0) {
      mediaKey = `tvdb:${tvdbId}`;
    }
    if (!mediaKey) return null;

    return {
      mediaKey,
      tmdbId: tmdbId > 0 ? tmdbId : null,
      imdbId,
      tvdbId: tvdbId > 0 ? tvdbId : null,
      mediaTitle: String(payload?.name || payload?.title || "").trim(),
      mediaYear: null,
    };
  }

  function mediaForSlug(slug) {
    const detail = detailForSlug(slug);
    return detail?.mediaKey ? detail : null;
  }

  function detailForSlug(slug) {
    return state.detailCache.torrents[String(slug || "").toLowerCase()] || null;
  }

  // ─── Cache normalization ───────────────────────────────────────────────────

  function normalizeCache(cache) {
    if (!cache || typeof cache !== "object") {
      return { version: 1, syncedAt: null, total: 0, releases: [] };
    }
    const releases = Array.isArray(cache.releases)
      ? cache.releases.map(normalizeRelease).filter(Boolean)
      : [];
    return {
      version: 1,
      syncedAt: cache.syncedAt || null,
      total: Number(cache.total) || releases.length,
      releases,
    };
  }

  function normalizeDetailCache(cache) {
    const torrents = {};
    if (cache?.torrents && typeof cache.torrents === "object") {
      for (const [key, detail] of Object.entries(cache.torrents)) {
        const slug = String(key || "").toLowerCase();
        if (!isValidSlug(slug) || !detail || typeof detail !== "object") continue;
        torrents[slug] = {
          slug,
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
    return { version: 1, torrents };
  }

  function normalizeRelease(item) {
    if (!item || typeof item !== "object") return null;

    const slug = String(item.slug || "").trim().toLowerCase();
    if (!isValidSlug(slug)) return null;

    const name = String(item.name || "").trim();

    // Chaque champ accepte le nom API (sync fraîche) ET le nom stocké en cache (rechargement).
    const sizeRaw = item.size_bytes ?? item.size;
    const seedRaw = item.seedtime_seconds ?? item.seedingTime;

    return {
      slug,
      name,
      normalizedKey: buildContentKey(name),
      category: String(item.cat_name || item.category || ""),
      downloadedAt: item.first_seen_at || item.downloadedAt || "",
      size: Number.isFinite(Number(sizeRaw)) ? Number(sizeRaw) : null,
      seedingTime: Number.isFinite(Number(seedRaw)) ? Number(seedRaw) : null,
      uploaded: Number.isFinite(Number(item.uploaded)) ? Number(item.uploaded) : null,
      isCompleted: Boolean(item.is_completed ?? item.isCompleted),
    };
  }

  function mergeReleases(existing, incoming) {
    return {
      ...existing,
      name: existing.name || incoming.name,
      normalizedKey: existing.normalizedKey || incoming.normalizedKey,
      category: existing.category || incoming.category,
      downloadedAt: existing.downloadedAt || incoming.downloadedAt,
      size: existing.size ?? incoming.size ?? null,
      seedingTime: existing.seedingTime ?? incoming.seedingTime ?? null,
      uploaded: existing.uploaded ?? incoming.uploaded ?? null,
      isCompleted: existing.isCompleted || incoming.isCompleted,
    };
  }

  // ─── Index ─────────────────────────────────────────────────────────────────

  function rebuildIndexes() {
    state.exactBySlug = new Map();
    state.altByKey = new Map();
    state.mediaBySlug = new Map();
    state.altByMediaKey = new Map();

    for (const release of state.cache.releases) {
      state.exactBySlug.set(release.slug, release);

      const media = mediaForSlug(release.slug);
      if (media?.mediaKey) {
        state.mediaBySlug.set(release.slug, media);
        const list = state.altByMediaKey.get(media.mediaKey) || [];
        list.push(release);
        state.altByMediaKey.set(media.mediaKey, list);
      }

      if (release.normalizedKey) {
        const list = state.altByKey.get(release.normalizedKey) || [];
        list.push(release);
        state.altByKey.set(release.normalizedKey, list);
      }
    }
  }

  // ─── DOM observers ─────────────────────────────────────────────────────────

  function observePageChanges() {
  new MutationObserver(() => {
    if (state.statusEl) {
      state.statusEl.style.display = /^\/communication(\/|$)/.test(window.location.pathname) ? "none" : "";
    }
    scheduleAnnotate();
  }).observe(document.body, { childList: true, subtree: true });
}

  function scheduleAnnotate() {
    window.clearTimeout(state.annotateTimer);
    state.annotateTimer = window.setTimeout(annotateTorrentLinks, 120);
  }

  // ─── Annotation ────────────────────────────────────────────────────────────

  function annotateTorrentLinks() {
    // Les pages torrent TR4KER sont /torrent/<slug> (singulier).
    // Les liens /api/torrents/.../download ne contiennent pas /torrent/ donc
    // le sélecteur ne les attrape pas, mais on filtre quand même par sécurité.
    const links = document.querySelectorAll('a[href*="/torrent/"]');

    for (const link of links) {
      if (link.dataset.tr4kerDlProcessed === "1") continue;

      if (DOWNLOAD_URL_RE.test(link.href)) {
        link.dataset.tr4kerDlProcessed = "1";
        continue;
      }

      const slug = extractSlug(link.href);
      if (!slug) continue;

      const exactRelease = state.exactBySlug.get(slug);
      if (exactRelease) {
        const titleInfo = findTitleInfo(link);
        if (!titleInfo) { link.dataset.tr4kerDlProcessed = "1"; continue; }

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

        if (!mediaForSlug(slug)) queueTorrentDetailFetch(slug);
        continue;
      }

      if (state.settings.showAltBadge) {
        const titleInfo = findTitleInfo(link);
        if (!titleInfo?.title) { link.dataset.tr4kerDlProcessed = "1"; continue; }

        const detail = detailForSlug(slug);
        const media = detail?.mediaKey ? detail : null;
        const altMatches = media?.mediaKey
          ? (state.altByMediaKey.get(media.mediaKey) || []).filter((r) => r.slug !== slug)
          : [];

        if (altMatches.length) {
          addBadge(link, titleInfo, { type: "alt", label: "ALT ✓", title: altTooltip(altMatches, media) });
        } else if (!detail?.fetchedAt) {
          queueTorrentDetailFetch(slug);
        } else if (!media?.mediaKey) {
          if (needsTorrentDetailFetch(slug)) queueTorrentDetailFetch(slug);
          const fallback = findFallbackAltMatches(slug, titleInfo.title);
          if (fallback.length) {
            addBadge(link, titleInfo, { type: "alt", label: "ALT!", title: altTooltip(fallback, null) });
          }
        }
      }

      link.dataset.tr4kerDlProcessed = "1";
    }
  }

  function findFallbackAltMatches(slug, title) {
    const key = buildContentKey(title);
    return key ? (state.altByKey.get(key) || []).filter((r) => r.slug !== slug) : [];
  }

  function clearBadges() {
    for (const badge of document.querySelectorAll(".tr4ker-dl-badge")) badge.remove();
    for (const link of document.querySelectorAll("[data-tr4ker-dl-processed]")) {
      delete link.dataset.tr4kerDlProcessed;
    }
  }

  // ─── DOM helpers ───────────────────────────────────────────────────────────

  function findTitleInfo(link) {
    // TR4KER : le lien <a class="_row_..."> contient le titre dans un <span>.
    // Sélecteur partiel sur le hash de build CSS (_tnoc8_, etc.) pour rester stable.
    const nameSpan =
      link.querySelector('span[class*="rowNameText"]') ||
      link.querySelector('p[class*="rowName"] > span');

    if (nameSpan && cleanText(nameSpan.textContent).length > 2) {
      return { title: cleanText(nameSpan.textContent), target: nameSpan, mode: "append-target" };
    }

    // Fallback : lien texte direct (page détail, etc.)
    const directText = cleanText(link.textContent);
    if (directText.length > 2 && link.children.length <= 1) {
      return { title: directText, target: link, mode: "after-target" };
    }

    return null;
  }

  function addBadge(link, titleInfo, badgeInfo) {
    if (link.querySelector(`.tr4ker-dl-badge--${badgeInfo.type}`)) {
      link.dataset.tr4kerDlProcessed = "1";
      return;
    }

    const badge = document.createElement("span");
    badge.className = `tr4ker-dl-badge tr4ker-dl-badge--${badgeInfo.type}`;
    if (badgeInfo.extraClass) badge.classList.add(badgeInfo.extraClass);
    badge.textContent = badgeInfo.label;
    badge.title = badgeInfo.title;

    const target = titleInfo.target;
    if (titleInfo.mode === "append-target") {
      if (!target.querySelector(".tr4ker-dl-badge")) {
        target.appendChild(document.createTextNode(" "));
      }
      target.appendChild(badge);
    } else {
      insertAfterLastBadge(target, badge);
    }

    link.dataset.tr4kerDlProcessed = "1";
  }

  function insertAfterLastBadge(target, badge) {
    let anchor = target;
    let next = target.nextElementSibling;
    while (next && next.classList.contains("tr4ker-dl-badge")) {
      anchor = next;
      next = next.nextElementSibling;
    }
    anchor.insertAdjacentElement("afterend", badge);
  }

  // ─── Slug helpers ──────────────────────────────────────────────────────────

  function isValidSlug(slug) {
    return /^[a-z0-9][a-z0-9-]{2,}[a-z0-9]$/i.test(slug);
  }

  function extractSlug(url) {
    const str = String(url || "");
    const m1 = str.match(SLUG_RE);
    if (m1) return m1[1].toLowerCase();
    const m2 = str.match(DOWNLOAD_URL_RE);
    if (m2) return m2[1].toLowerCase();
    return "";
  }

  function extractDownloadSlug(action) {
    const urls = [
      action.href,
      action.getAttribute("href"),
      findTorrentLinkForAction(action)?.href,
      window.location.href,
    ];
    for (const url of urls) {
      const slug = extractSlug(url);
      if (slug) return slug;
    }
    return "";
  }

  function findDownloadName(action, slug) {
    const torrentLink = findTorrentLinkForAction(action);
    const titleInfo = torrentLink ? findTitleInfo(torrentLink) : null;
    if (titleInfo?.title) return titleInfo.title;

    const pageTitle = cleanText(document.querySelector("h1")?.textContent);
    if (pageTitle.length > 2) return pageTitle;

    const documentTitle = cleanText(document.title).replace(/\s*[-|]\s*TR4KER.*$/i, "");
    if (documentTitle.length > 2) return documentTitle;

    return `Torrent ${slug}`;
  }

  function findTorrentLinkForAction(action) {
    if (action.matches?.('a[href*="/torrent/"]') && !DOWNLOAD_URL_RE.test(action.href || "")) {
      return action;
    }
    const parentLink = action.closest?.('a[href*="/torrent/"]');
    if (parentLink && !DOWNLOAD_URL_RE.test(parentLink.href || "")) return parentLink;

    const container = action.closest?.("tr, li, article, section, [class*='row']");
    return container?.querySelector('a[href*="/torrent/"]:not([href*="/download"])') || null;
  }

  function findDefaultDebugSlug() {
    return (
      extractSlug(window.location.href) ||
      extractSlug(document.querySelector('a[href*="/torrent/"]')?.href) ||
      ""
    );
  }

  // ─── Debug ─────────────────────────────────────────────────────────────────

  async function debugTorrentApi(slug) {
    if (!isValidSlug(slug)) throw new Error("Slug invalide");

    updateStatus("Debug API torrent...");
    const url = new URL(`/api/torrents/${slug}`, window.location.origin);
    const response = await fetch(url.toString(), {
      method: "GET", credentials: "include",
      headers: { accept: "application/json" },
    });

    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch {}

    console.group(`[TR4KER DL] Debug API ${slug}`);
    console.log("URL", url.toString());
    console.log("HTTP", response.status, response.statusText);
    console.log("JSON", payload);
    console.log("Raw", text);
    console.groupEnd();

    if (response.status === 404) {
      storeTorrentDetailNotFound(slug);
    } else if (payload) {
      storeTorrentDetail(slug, payload);
    }
    if (payload || response.status === 404) {
      GM_setValue(DETAILS_KEY, state.detailCache);
      rebuildIndexes(); clearBadges(); scheduleAnnotate();
    }
    updateStatus(`Debug API: HTTP ${response.status}, voir console`);
    return payload || text;
  }

  // ─── Badge tooltips ────────────────────────────────────────────────────────

  function exactTooltip(release) {
    const parts = ["Torrent exact deja telecharge"];
    if (release.downloadedAt) parts.push(`le ${formatDownloadedAt(release.downloadedAt)}`);
    if (release.name) parts.push(release.name);
    return parts.join("\n");
  }

  function seedTooltip(release) {
    const parts = ["Seed actif"];
    const ratio = seedRatio(release);
    if (ratio !== null) parts.push(`ratio ${formatRatio(ratio)}`);
    if (Number.isFinite(Number(release.seedingTime))) {
      parts.push(`depuis ${formatDuration(Number(release.seedingTime))}`);
    }
    if (Number.isFinite(Number(release.uploaded))) {
      parts.push(`upload ${formatBytes(Number(release.uploaded))}`);
    }
    if (release.name) parts.push(release.name);
    return parts.join("\n");
  }

  function altTooltip(matches, media) {
    const lines = [`Autre release deja telechargee (${matches.length})`];
    if (media?.mediaTitle || media?.mediaKey) {
      const year = media.mediaYear ? ` (${media.mediaYear})` : "";
      lines.push(`${media.mediaTitle || media.mediaKey}${year}`);
    }
    for (const m of matches.slice(0, 3)) {
      const date = m.downloadedAt ? ` - ${formatDownloadedAt(m.downloadedAt)}` : "";
      lines.push(`${m.name}${date}`);
    }
    if (matches.length > 3) lines.push(`... +${matches.length - 3}`);
    return lines.join("\n");
  }

  // ─── Release helpers ───────────────────────────────────────────────────────

  function isActiveSeedRelease(release) {
    // TR4KER n'a pas d'endpoint "active-seeds" distinct.
    // On considère actif tout torrent avec seedtime_seconds > 0.
    return Number(release.seedingTime) > 0;
  }

  function seedRatio(release) {
    const uploaded = Number(release.uploaded);
    const size = Number(release.size);
    if (!Number.isFinite(uploaded) || !Number.isFinite(size) || size <= 0) return null;
    return uploaded / size;
  }

  function seedRatioClass(release) {
    const ratio = seedRatio(release);
    if (ratio === null) return "";
    if (ratio < 1) return "tr4ker-dl-badge--seed-ratio-low";
    if (ratio < 2) return "tr4ker-dl-badge--seed-ratio-warn";
    if (ratio < 3) return "tr4ker-dl-badge--seed-ratio-mid";
    if (ratio < 4) return "tr4ker-dl-badge--seed-ratio-good";
    if (ratio < 5) return "tr4ker-dl-badge--seed-ratio-ok";
    return "";
  }

  // ─── Content key (matching ALT) ────────────────────────────────────────────

  function buildContentKey(name) {
    const cleaned = normalizeName(name);
    if (!cleaned) return "";

    const tokens = cleaned.split(" ").map((t) => t.trim()).filter(Boolean).filter((t) => !isTechnicalToken(t));
    if (tokens.length < 2) return "";

    const seasonIdx = tokens.findIndex((t) => /^s\d{1,2}(e\d{1,3})?$/.test(t));
    if (seasonIdx > 0) return compactKey(tokens.slice(0, seasonIdx + 1));

    const yearIdx = tokens.findIndex((t) => /^(19|20)\d{2}$/.test(t));
    if (yearIdx > 0) {
      const slice = tokens.slice(0, yearIdx + 1);
      // Supprimer les chiffres romains isolés juste avant l'année :
      // "Bad Boys I 1995" et "Bad Boys 1995" produisent la même key.
      // Les chiffres arabes (1, 2...) ne sont pas strippés car ils peuvent
      // distinguer des suites légitimes — le matching TMDB gère ces cas.
      const beforeYear = slice[slice.length - 2];
      if (slice.length >= 3 && /^(i{1,3}|iv|vi{0,3}|ix|x)$/i.test(beforeYear)) {
        slice.splice(slice.length - 2, 1);
      }
      return compactKey(slice);
    }

    const useful = stripLikelyReleaseGroup(tokens);
    if (useful.length < 3) return "";
    return compactKey(useful.slice(0, 8));
  }

  function normalizeName(name) {
    return String(name || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
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
      .replace(/\s+/g, " ").trim();
  }

  function isTechnicalToken(token) {
    if (TECHNICAL_TOKENS.has(token)) return true;
    if (/^\d{3,4}p$/.test(token)) return true;
    if (/^\d+(bit|bits|fps|hz|khz|mbps|kbps)$/.test(token)) return true;
    if (/^\d+ch$/.test(token)) return true;
    return false;
  }

  function stripLikelyReleaseGroup(tokens) {
    if (tokens.length <= 3) return tokens;
    const copy = tokens.slice();
    const last = copy[copy.length - 1];
    if (/^[a-z]{2,12}\d{0,4}$/.test(last) && !/^(19|20)\d{2}$/.test(last)) copy.pop();
    return copy;
  }

  function compactKey(tokens) {
    const key = tokens.join(" ").trim();
    return key.length >= 8 ? key : "";
  }

  // ─── Format helpers ────────────────────────────────────────────────────────

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function formatDate(date) {
    return date.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  function formatDuration(seconds) {
    const units = [["j", 86400], ["h", 3600], ["min", 60]];
    const parts = [];
    let rem = Math.max(0, Math.floor(seconds));
    for (const [label, size] of units) {
      const v = Math.floor(rem / size);
      if (v) { parts.push(`${v} ${label}`); rem -= v * size; }
      if (parts.length >= 2) break;
    }
    return parts.length ? parts.join(" ") : `${rem} s`;
  }

  function formatBytes(bytes) {
    const units = ["o", "Ko", "Mo", "Go", "To"];
    let v = Math.max(0, bytes);
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    const r = v >= 10 || i === 0 ? Math.round(v) : Math.round(v * 10) / 10;
    return `${r} ${units[i]}`;
  }

  function formatRatio(value) {
    return value < 10 ? value.toFixed(2) : value.toFixed(1);
  }

  function formatDownloadedAt(value) {
    const d = new Date(String(value || ""));
    if (!d || isNaN(d.getTime())) return String(value || "");
    return d.toLocaleString("fr-FR", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  }
})();
