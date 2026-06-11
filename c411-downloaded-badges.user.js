// ==UserScript==
// @name         C411 - Pastilles torrents telecharges
// @namespace    https://c411.org/
// @version      0.1.1
// @description  Marque les torrents deja telecharges sur C411 avec des pastilles DL et ALT.
// @author       Butchered
// @match        https://c411.org/*
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
  "use strict";

  const STORAGE_KEY = "c411DownloadedBadges.cache.v1";
  const SETTINGS_KEY = "c411DownloadedBadges.settings.v1";
  const RECENT_DOWNLOAD_CLICK_KEY = "c411DownloadedBadges.recentDownloadClick.v1";
  const HASH_RE = /\/torrents\/([a-f0-9]{40})(?:[/?#]|$)/i;

  const DEFAULT_SETTINGS = {
    autoSyncHours: 24,
    downloadSyncDelayMs: 4000,
    perPage: 20,
    showAltBadge: true,
    maxPagesPerSync: 200,
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
    settings: { ...DEFAULT_SETTINGS, ...GM_getValue(SETTINGS_KEY, {}) },
    exactByHash: new Map(),
    altByKey: new Map(),
    syncInProgress: false,
    annotateTimer: null,
    downloadSyncTimer: null,
    statusEl: null,
  };

  addStyles();
  rebuildIndexes();
  registerMenu();
  renderStatusWidget();
  scheduleAnnotate();
  observePageChanges();
  observeDownloadClicks();
  maybeSyncAfterRecentDownloadClick();
  maybeAutoSync();

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
      state.cache = normalizeCache(null);
      rebuildIndexes();
      clearBadges();
      scheduleAnnotate();
      updateStatus("Cache vide");
    });
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

    const date = state.cache.syncedAt ? new Date(state.cache.syncedAt) : null;
    const synced = date && !Number.isNaN(date.getTime()) ? formatDate(date) : "date inconnue";
    return `DL: ${count} torrents, sync ${synced}`;
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
      let total = 0;
      let totalPages = 1;

      for (let page = 1; page <= totalPages; page += 1) {
        if (page > maxPages) {
          throw new Error(`limite ${maxPages} pages atteinte`);
        }

        updateStatus(`Sync page ${page}/${totalPages}...`);
        const payload = await fetchDownloadsPage(page, perPage);
        const items = Array.isArray(payload.data) ? payload.data : [];

        for (const item of items) {
          const release = normalizeRelease(item);
          if (release) {
            releasesByHash.set(release.infoHash, release);
          }
        }

        if (payload.meta && Number.isFinite(Number(payload.meta.totalPages))) {
          totalPages = Math.max(1, Number(payload.meta.totalPages));
        }

        if (payload.meta && Number.isFinite(Number(payload.meta.total))) {
          total = Number(payload.meta.total);
        }
      }

      state.cache = {
        version: 1,
        syncedAt: new Date().toISOString(),
        total,
        totalPages,
        releases: Array.from(releasesByHash.values()),
      };

      GM_setValue(STORAGE_KEY, state.cache);
      rebuildIndexes();
      clearBadges();
      scheduleAnnotate();
      updateStatus(statusSummary());
    } finally {
      state.syncInProgress = false;
      updateStatus(statusSummary());
    }
  }

  async function fetchDownloadsPage(page, perPage) {
    const url = new URL("/api/profile/downloads", window.location.origin);
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

  function normalizeCache(cache) {
    if (!cache || typeof cache !== "object") {
      return {
        version: 1,
        syncedAt: null,
        total: 0,
        totalPages: 0,
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
      releases,
    };
  }

  function normalizeRelease(item) {
    if (!item || typeof item !== "object" || !item.infoHash) {
      return null;
    }

    const infoHash = String(item.infoHash).toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(infoHash)) {
      return null;
    }

    const name = String(item.name || "").trim();
    const key = buildContentKey(name);

    return {
      infoHash,
      torrentId: item.torrentId ?? null,
      name,
      normalizedKey: key,
      category: item.category && item.category.name ? String(item.category.name) : "",
      downloadedAt: item.downloadedAt || "",
    };
  }

  function rebuildIndexes() {
    state.exactByHash = new Map();
    state.altByKey = new Map();

    for (const release of state.cache.releases) {
      state.exactByHash.set(release.infoHash, release);

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

      const titleInfo = findTitleInfo(link);
      if (!titleInfo || !titleInfo.title) {
        continue;
      }

      const exactRelease = state.exactByHash.get(hash);
      if (exactRelease) {
        addBadge(link, titleInfo, {
          type: "exact",
          label: "DL",
          title: exactTooltip(exactRelease),
        });
        continue;
      }

      if (state.settings.showAltBadge) {
        const key = buildContentKey(titleInfo.title);
        const altMatches = key ? (state.altByKey.get(key) || []).filter((release) => release.infoHash !== hash) : [];

        if (altMatches.length) {
          addBadge(link, titleInfo, {
            type: "alt",
            label: "ALT",
            title: altTooltip(altMatches),
          });
        }
      }

      link.dataset.c411DlProcessed = "1";
    }
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

  function findTitleInfo(link) {
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

  function addBadge(link, titleInfo, badgeInfo) {
    if (link.querySelector(".c411-dl-badge")) {
      link.dataset.c411DlProcessed = "1";
      return;
    }

    const badge = document.createElement("span");
    badge.className = `c411-dl-badge c411-dl-badge--${badgeInfo.type}`;
    badge.textContent = badgeInfo.label;
    badge.title = badgeInfo.title;

    const target = titleInfo.target;
    if (titleInfo.mode === "append-target") {
      target.appendChild(document.createTextNode(" "));
      target.appendChild(badge);
    } else if (target.parentElement && target.parentElement.classList.contains("flex")) {
      target.insertAdjacentElement("afterend", badge);
    } else {
      target.insertAdjacentElement("afterend", badge);
    }

    link.dataset.c411DlProcessed = "1";
  }

  function exactTooltip(release) {
    const parts = ["Torrent exact deja telecharge"];
    if (release.downloadedAt) {
      parts.push(`le ${release.downloadedAt}`);
    }
    if (release.name) {
      parts.push(release.name);
    }
    return parts.join("\n");
  }

  function altTooltip(matches) {
    const lines = [`Autre release deja telechargee (${matches.length})`];
    for (const match of matches.slice(0, 3)) {
      const date = match.downloadedAt ? ` - ${match.downloadedAt}` : "";
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
})();
