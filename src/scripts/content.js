// Constants
const EXTENSION_STATUS = {
    DISABLED: 1,
    ENABLED: 2,
    RUNNING: 3
};

const PC_ARTICLE_LINK_SELECTOR = 'a.article, a.tit, a[href*="/articles/"], a[href*="ArticleRead.nhn"]';
const MOBILE_ARTICLE_LINK_SELECTOR = 'a.mainLink, a.feedContent, a.fullLink';
const ART_CACHE_TTL_MS = 10 * 60 * 1000;
const API_META_EVENT = '__nspy_api_meta__';

// State
let extensionStatus = EXTENSION_STATUS.DISABLED;
let activeTasks = 0;
const artCache = new Map();
const inFlightRequests = new Map();
let globalLoggedIn = null;
const cafeMemberMap = new Map();
const articleMetaMap = new Map();
const loggedReadableArticles = new Set();
const pendingAuthWaiters = [];
let mainObserver;
let iframeObservers = [];
const iframeStateMap = new WeakMap();

const notifyAuthWaiters = () => {
    const waiters = pendingAuthWaiters.splice(0, pendingAuthWaiters.length);
    waiters.forEach(fn => fn());
};

document.addEventListener(API_META_EVENT, (event) => {
    try {
        const payload = typeof event.detail === 'string' ? JSON.parse(event.detail) : event.detail;
        if (!payload) return;

        if (payload.type === 'auth') {
            globalLoggedIn = payload.loggedIn;
            notifyAuthWaiters();
        } else if (payload.type === 'member' && payload.cafeId) {
            cafeMemberMap.set(String(payload.cafeId), {
                isMember: Boolean(payload.isMember),
                level: Number(payload.level) || 0,
                isStaff: Boolean(payload.isStaff)
            });
            notifyAuthWaiters();
        } else if (payload.type === 'articles' && Array.isArray(payload.articles)) {
            for (const item of payload.articles) {
                if (!item?.articleId) continue;
                if (item.cafeId) {
                    articleMetaMap.set(`${item.cafeId}:${item.articleId}`, item);
                }
                articleMetaMap.set(`any:${item.articleId}`, item);
            }
        }
    } catch {
        // Ignore malformed event payloads
    }
});

const waitForMemberAuthIfNeeded = (cafeId, timeoutMs = 600) => {
    if (!cafeId || globalLoggedIn === false || cafeMemberMap.has(String(cafeId))) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        const check = () => {
            if (globalLoggedIn === false || cafeMemberMap.has(String(cafeId))) {
                clearTimeout(timer);
                const idx = pendingAuthWaiters.indexOf(check);
                if (idx !== -1) pendingAuthWaiters.splice(idx, 1);
                resolve();
            }
        };
        const timer = setTimeout(() => {
            const idx = pendingAuthWaiters.indexOf(check);
            if (idx !== -1) pendingAuthWaiters.splice(idx, 1);
            resolve();
        }, timeoutMs);
        pendingAuthWaiters.push(check);
    });
};

const isArticleAlreadyReadable = (cafeId, articleId, group) => {
    for (const { link } of group.items) {
        if (link.matches('a.txt, a.link_contents') && link.textContent.trim().length > 0) {
            return true;
        }
    }

    const meta = (cafeId && articleMetaMap.get(`${cafeId}:${articleId}`)) ||
        articleMetaMap.get(`any:${articleId}`);
    if (!meta) return false;

    if (meta.openArticle || meta.self || meta.hasSummary || meta.readLevel === 0) {
        return true;
    }

    const member = cafeId ? cafeMemberMap.get(String(cafeId)) : null;
    if (!member) return false;

    if (member.isStaff) return true;
    if (member.isMember && typeof meta.readLevel === 'number' && member.level >= meta.readLevel) {
        return true;
    }

    return false;
};

// Utility functions
const debounce = (func, wait) => {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
};

const updateIconStatus = (status) => {
    if (!chrome.runtime?.id) return;
    chrome.runtime.sendMessage({
        action: 'updateIconStatus',
        status
    });
};

// Core functions
const fetchNewUrl = async (isMobile, articleId, title, cafeName) => {
    const cleanTitle = title ? title.replace(/"/g, ' ').trim() : '';
    if (!articleId || !cleanTitle || !cafeName) return null;

    const encodedTitle = encodeURIComponent(cleanTitle);
    const searchUrl = isMobile
        ? `https://m.search.naver.com/search.naver?ssc=tab.m_cafe.all&query="${encodedTitle}"`
        : `https://search.naver.com/search.naver?ssc=tab.cafe.all&query="${encodedTitle}"`;

    try {
        const response = await chrome.runtime.sendMessage({
            action: 'fetchUrl',
            url: searchUrl
        });
        if (response.error) throw new Error(response.error);

        const parser = new DOMParser();
        const doc = parser.parseFromString(response.data, 'text/html');
        const links = doc.querySelectorAll('a[href*="cafe.naver.com/"][href*="art="]');

        for (const link of links) {
            const href = link.getAttribute('href');
            if (!href) continue;
            const url = new URL(href, 'https://search.naver.com');
            const pathParts = url.pathname.split('/').filter(Boolean);
            const urlCafeName = pathParts[0];
            const urlArticleId = pathParts[1];
            if (urlArticleId === String(articleId) && urlCafeName === cafeName) {
                return url.searchParams.get('art');
            }
        }

        const escapedCafe = cafeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rawMatch = response.data.match(
            new RegExp(`https://cafe\\.naver\\.com/${escapedCafe}/${articleId}\\?[^"'\\s<>\\\\]*art=([^&"'\\s<>\\\\]+)`)
        );
        if (rawMatch) {
            return decodeURIComponent(rawMatch[1]);
        }

        return null;
    } catch (error) {
        return undefined;
    }
};

const getArtToken = async (isMobile, articleId, title, cafeName) => {
    const cacheKey = `${cafeName}:${articleId}`;
    const cached = artCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < ART_CACHE_TTL_MS) {
        return cached.art;
    }
    if (inFlightRequests.has(cacheKey)) {
        return inFlightRequests.get(cacheKey);
    }

    const requestPromise = (async () => {
        let art = await fetchNewUrl(isMobile, articleId, title, cafeName);
        if (art === null && isMobile && /^\[[^\]]+\]\s+/.test(title)) {
            const strippedTitle = title.replace(/^\[[^\]]+\]\s+/, '');
            art = await fetchNewUrl(isMobile, articleId, strippedTitle, cafeName);
        }
        if (art !== undefined) {
            artCache.set(cacheKey, { art, ts: Date.now() });
        }
        return art || null;
    })().finally(() => {
        inFlightRequests.delete(cacheKey);
    });

    inFlightRequests.set(cacheKey, requestPromise);
    return requestPromise;
};

const cafeInfoCache = new Map();

const fetchCafeInfo = async ({ cafeUrl, cafeId }) => {
    const cacheKey = cafeUrl ? `url:${cafeUrl}` : cafeId ? `id:${cafeId}` : '';
    if (!cacheKey) return null;
    if (cafeInfoCache.has(cacheKey)) {
        return cafeInfoCache.get(cacheKey);
    }

    const query = cafeUrl
        ? `cluburl=${encodeURIComponent(cafeUrl)}`
        : `cafeId=${encodeURIComponent(cafeId)}`;
    const apiUrl = `https://apis.naver.com/cafe-web/cafe2/CafeGateInfo.json?${query}`;
    try {
        const response = await fetch(apiUrl, {
            credentials: 'include',
            headers: { 'Accept': 'application/json' }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const json = await response.json();
        const cafeInfo = json?.message?.result?.cafeInfoView;
        if (!cafeInfo?.cafeId || !cafeInfo?.cafeUrl) throw new Error('cafeInfo not found');

        const result = {
            cafeName: cafeInfo.cafeUrl,
            cafeIndex: cafeInfo.cafeId.toString()
        };

        cafeInfoCache.set(`url:${result.cafeName}`, result);
        cafeInfoCache.set(`id:${result.cafeIndex}`, result);
        return result;
    } catch (err) {
        return null;
    }
};

const resolveMobileCafeIdentifier = () => {
    const parts = location.pathname.split('/').filter(Boolean);
    const cafesIdx = parts.indexOf('cafes');
    if (cafesIdx !== -1 && parts[cafesIdx + 1]) {
        const idOrUrl = parts[cafesIdx + 1];
        return /^\d+$/.test(idOrUrl) ? { cafeId: idOrUrl } : { cafeUrl: idOrUrl };
    }
    if (parts[0] === 'ca-fe' && parts[1] && parts[1] !== 'web') {
        return { cafeUrl: parts[1] };
    }
    if (parts.length === 1 && !parts[0].endsWith('.nhn')) {
        return { cafeUrl: parts[0] };
    }
    return null;
};

const waitForElement = (doc, selector, timeout = 5000) => {
    return new Promise((resolve, reject) => {
        const element = doc.querySelector(selector);
        if (element) return resolve(element);
        if (!doc.body) return reject(new Error('Document body not ready'));

        const observer = new MutationObserver(() => {
            const el = doc.querySelector(selector);
            if (el) {
                observer.disconnect();
                resolve(el);
            }
        });

        observer.observe(doc.body, {
            childList: true,
            subtree: true
        });

        setTimeout(() => {
            observer.disconnect();
            reject(new Error('Timeout waiting for element: ' + selector));
        }, timeout);
    });
};

const parseArticleLinkInfo = (link) => {
    try {
        if (!link?.href) return null;
        const url = new URL(link.href);
        if (!url.hostname.endsWith('cafe.naver.com')) return null;

        const currentArt = url.searchParams.get('art');
        if (currentArt && currentArt === link.dataset.nspyArt) return null;

        const pathParts = url.pathname.split('/').filter(Boolean);
        let cafeId = url.searchParams.get('clubid');
        let articleId = null;

        const cafeIndex = pathParts.indexOf('cafes');
        const articleIndex = pathParts.indexOf('articles');

        if (cafeIndex !== -1 && pathParts.length > cafeIndex + 1) {
            cafeId = pathParts[cafeIndex + 1];
        }
        if (articleIndex !== -1 && articleIndex === pathParts.length - 2) {
            articleId = pathParts[articleIndex + 1];
        } else if (url.pathname.endsWith('/ArticleRead.nhn')) {
            articleId = url.searchParams.get('articleid');
        }

        if (!articleId || !/^\d+$/.test(articleId)) return null;
        return { url, cafeId, articleId };
    } catch (e) {
        return null;
    }
};

const applyBypassUrl = (link, doc, articleId, art, isMobile) => {
    const currentInfo = parseArticleLinkInfo(link);
    if (!currentInfo || currentInfo.articleId !== articleId) return;

    currentInfo.url.searchParams.set('art', art);
    link.href = currentInfo.url.toString();
    link.dataset.nspyArt = art;
    link.removeAttribute('onclick');

    if (!link.dataset.nspyBound) {
        link.dataset.nspyBound = '1';
        link.addEventListener('click', (e) => {
            if (extensionStatus === EXTENSION_STATUS.DISABLED) return;
            if (!link.dataset.nspyArt) return;

            let currentUrl;
            try {
                currentUrl = new URL(link.href);
            } catch {
                return;
            }
            if (currentUrl.searchParams.get('art') !== link.dataset.nspyArt) return;

            const targetUrl = link.href;
            if (link.target === '_blank' || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) {
                e.stopImmediatePropagation();
                return;
            }

            e.preventDefault();
            e.stopImmediatePropagation();

            if (isMobile) {
                window.location.replace(targetUrl);
            } else {
                const isTopNavigation = doc === document ||
                    link.target === '_top' ||
                    link.target === '_parent' ||
                    currentUrl.pathname.startsWith('/f-e/');
                const targetWin = isTopNavigation ? window : (doc.defaultView || window);
                targetWin.location.href = targetUrl;
            }
        }, true);
    }
};

const replaceSpyLinks = async (doc) => {
    if (extensionStatus === EXTENSION_STATUS.DISABLED) return;
    if (!location.hostname.endsWith('cafe.naver.com')) return;

    if (doc.readyState !== 'complete' && doc.readyState !== 'interactive') {
        await new Promise(resolve => doc.addEventListener('DOMContentLoaded', resolve, { once: true }));
    }

    const isMobile = /Mobi|Android/i.test(navigator.userAgent);

    if (isMobile) {
        const cafeIdentifier = resolveMobileCafeIdentifier();
        if (!cafeIdentifier) return;

        const cafeInfo = await fetchCafeInfo(cafeIdentifier);
        if (!cafeInfo) return;

        const { cafeName, cafeIndex } = cafeInfo;
        try {
            await waitForElement(doc, MOBILE_ARTICLE_LINK_SELECTOR);
        } catch (e) {
            return;
        }

        await waitForMemberAuthIfNeeded(cafeIndex);

        const articleLinks = doc.querySelectorAll(MOBILE_ARTICLE_LINK_SELECTOR);
        const articleGroups = new Map();

        for (const link of articleLinks) {
            const container = link.closest('.FeedItemWrap, .MultiLinkWrap') || link;
            const badgeEl = container.querySelector('.CdsBadgeText');
            if (badgeEl && /^(공지|필독)$/.test(badgeEl.textContent.trim())) continue;

            const info = parseArticleLinkInfo(link);
            if (!info) continue;

            if (!articleGroups.has(info.articleId)) {
                articleGroups.set(info.articleId, { title: '', items: [] });
            }
            const group = articleGroups.get(info.articleId);
            group.items.push({ link, url: info.url });

            if (!group.title) {
                const titleEl = container.querySelector('.tit');
                if (titleEl) {
                    group.title = titleEl.textContent.replace(/^\[원글이 삭제된 답글\]\s*/, '').trim();
                }
            }
        }

        if (articleGroups.size === 0) return;

        const allEntries = Array.from(articleGroups.entries());
        const targetEntries = [];
        let newlySkipped = 0;
        for (const entry of allEntries) {
            const [id, group] = entry;
            if (isArticleAlreadyReadable(cafeIndex, id, group)) {
                const key = `${cafeName}:${id}`;
                if (!loggedReadableArticles.has(key)) {
                    loggedReadableArticles.add(key);
                    newlySkipped++;
                }
            } else {
                targetEntries.push(entry);
            }
        }

        const uncachedCount = targetEntries.filter(([id, group]) => {
            if (!group.title) return false;
            const cached = artCache.get(`${cafeName}:${id}`);
            return !cached || Date.now() - cached.ts >= ART_CACHE_TTL_MS;
        }).length;

        if (newlySkipped > 0 || uncachedCount > 0) {
            console.debug(`[NSpy] evaluated=${allEntries.length}, skippedReadable=${allEntries.length - targetEntries.length}, searchRequests=${uncachedCount}`);
        }

        if (targetEntries.length === 0) return;

        const needsNetwork = uncachedCount > 0;

        if (needsNetwork) {
            activeTasks++;
            updateIconStatus(EXTENSION_STATUS.RUNNING);
        }

        try {
            const promises = targetEntries.map(async ([articleId, group]) => {
                const cached = artCache.get(`${cafeName}:${articleId}`);
                const hasFreshCache = cached && Date.now() - cached.ts < ART_CACHE_TTL_MS;
                if (!hasFreshCache && !group.title) return;

                const art = hasFreshCache
                    ? cached.art
                    : await getArtToken(true, articleId, group.title, cafeName);
                if (art) {
                    for (const { link } of group.items) {
                        applyBypassUrl(link, doc, articleId, art, true);
                    }
                }
            });
            await Promise.all(promises);
        } finally {
            if (needsNetwork) {
                activeTasks = Math.max(0, activeTasks - 1);
                if (activeTasks === 0 && extensionStatus !== EXTENSION_STATUS.DISABLED) {
                    updateIconStatus(EXTENSION_STATUS.ENABLED);
                }
            }
        }
    } else {
        const articleLinks = doc.querySelectorAll(PC_ARTICLE_LINK_SELECTOR);
        if (articleLinks.length === 0) return;

        const articleGroups = new Map();
        let fallbackCafeId = null;

        for (const link of articleLinks) {
            if (link.closest('tr.board-notice:not(.type_up)')) continue;

            const info = parseArticleLinkInfo(link);
            if (!info) continue;

            if (!fallbackCafeId && info.cafeId && /^\d+$/.test(info.cafeId)) {
                fallbackCafeId = info.cafeId;
            }

            if (!articleGroups.has(info.articleId)) {
                articleGroups.set(info.articleId, { title: '', items: [] });
            }
            const group = articleGroups.get(info.articleId);
            group.items.push({ link, url: info.url });

            if (!group.title) {
                if (link.matches('a.article, a.tit')) {
                    group.title = extractTitle(link);
                } else {
                    const row = link.closest('li, tr');
                    const titleLink = row && row.querySelector('a.article, a.tit');
                    if (titleLink) {
                        group.title = extractTitle(titleLink);
                    }
                }
            }
        }

        if (articleGroups.size === 0) return;

        let cafeName = extractCafeName(doc);
        if (!cafeName && doc !== document) {
            cafeName = extractCafeName(document);
        }
        if (!cafeName && fallbackCafeId) {
            const cafeInfo = await fetchCafeInfo({ cafeId: fallbackCafeId });
            cafeName = cafeInfo ? cafeInfo.cafeName : '';
        }
        if (!cafeName) return;

        await waitForMemberAuthIfNeeded(fallbackCafeId);

        const allEntries = Array.from(articleGroups.entries());
        const targetEntries = [];
        let newlySkipped = 0;
        for (const entry of allEntries) {
            const [id, group] = entry;
            if (isArticleAlreadyReadable(fallbackCafeId, id, group)) {
                const key = `${cafeName}:${id}`;
                if (!loggedReadableArticles.has(key)) {
                    loggedReadableArticles.add(key);
                    newlySkipped++;
                }
            } else {
                targetEntries.push(entry);
            }
        }

        const uncachedCount = targetEntries.filter(([id, group]) => {
            if (!group.title) return false;
            const cached = artCache.get(`${cafeName}:${id}`);
            return !cached || Date.now() - cached.ts >= ART_CACHE_TTL_MS;
        }).length;

        if (newlySkipped > 0 || uncachedCount > 0) {
            console.debug(`[NSpy] evaluated=${allEntries.length}, skippedReadable=${allEntries.length - targetEntries.length}, searchRequests=${uncachedCount}`);
        }

        if (targetEntries.length === 0) return;

        const needsNetwork = uncachedCount > 0;

        if (needsNetwork) {
            activeTasks++;
            updateIconStatus(EXTENSION_STATUS.RUNNING);
        }

        try {
            const promises = targetEntries.map(async ([articleId, group]) => {
                const cached = artCache.get(`${cafeName}:${articleId}`);
                const hasFreshCache = cached && Date.now() - cached.ts < ART_CACHE_TTL_MS;
                if (!hasFreshCache && !group.title) return;

                const art = hasFreshCache
                    ? cached.art
                    : await getArtToken(false, articleId, group.title, cafeName);
                if (art) {
                    for (const { link } of group.items) {
                        applyBypassUrl(link, doc, articleId, art, false);
                    }
                }
            });
            await Promise.all(promises);
        } finally {
            if (needsNetwork) {
                activeTasks = Math.max(0, activeTasks - 1);
                if (activeTasks === 0 && extensionStatus !== EXTENSION_STATUS.DISABLED) {
                    updateIconStatus(EXTENSION_STATUS.ENABLED);
                }
            }
        }
    }
};

const extractCafeName = (doc) => {
    const scriptTags = doc.querySelectorAll('script');
    for (const script of scriptTags) {
        const text = script.textContent;
        const match = text.match(/\\"cafeUrl\\":\\"([^"]+)\\"/) ||
            text.match(/"cafeUrl"\s*:\s*"([^"]+)"/) ||
            text.match(/sCafeUrl\s*:\s*["']([^"']+)["']/);
        if (match) return match[1];
    }
    return '';
};

const extractTitle = (link) => {
    const titTxt = link.querySelector('.tit_txt');
    if (titTxt) {
        return titTxt.textContent.trim();
    }
    const clone = link.cloneNode(true);
    clone.querySelectorAll('span.head, span.blind, [class*="SaleStatusLabel"]').forEach(el => el.remove());
    return clone.textContent.trim();
};

// Observer functions
const hasMatchingLinks = (node, selector) => {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    return (node.matches && node.matches(selector)) ||
        Boolean(node.querySelector && node.querySelector(selector));
};

const initContentScript = () => {
    if (extensionStatus === EXTENSION_STATUS.DISABLED) return;
    if (!location.hostname.endsWith('cafe.naver.com')) return;
    if (!document.body) {
        document.addEventListener('DOMContentLoaded', () => initContentScript(), { once: true });
        return;
    }

    stopContentScript();

    const isMobile = /Mobi|Android/i.test(navigator.userAgent);
    const linkSelector = isMobile ? MOBILE_ARTICLE_LINK_SELECTOR : PC_ARTICLE_LINK_SELECTOR;

    const debouncedReplaceLinks = debounce(() => {
        if (extensionStatus > EXTENSION_STATUS.DISABLED) {
            replaceSpyLinks(document);
        }
    }, 500);

    mainObserver = new MutationObserver((mutations) => {
        let shouldProcessLinks = false;

        for (const mutation of mutations) {
            if (mutation.type === 'childList') {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        if (node.tagName === 'IFRAME') {
                            handleIframeChanges(node);
                        }
                        if (hasMatchingLinks(node, linkSelector)) {
                            shouldProcessLinks = true;
                        }
                    }
                });
            }
        }

        if (shouldProcessLinks) {
            debouncedReplaceLinks();
        }
    });

    if (document.body) {
        mainObserver.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    document.querySelectorAll('iframe').forEach(handleIframeChanges);

    replaceSpyLinks(document);
};

const handleIframeChanges = (iframe) => {
    if (extensionStatus === EXTENSION_STATUS.DISABLED) return;

    let state = iframeStateMap.get(iframe);
    if (!state) {
        const processLinks = () => {
            if (extensionStatus === EXTENSION_STATUS.DISABLED) return;
            try {
                const iframeDocument = iframe.contentDocument || iframe.contentWindow?.document;
                if (iframeDocument) {
                    replaceSpyLinks(iframeDocument);
                }
            } catch (error) {
                // Ignore inaccessible cross-origin iframes
            }
        };

        const debouncedProcessLinks = debounce(processLinks, 500);

        const observeCurrentDocument = () => {
            try {
                const iframeDocument = iframe.contentDocument || iframe.contentWindow?.document;
                if (!iframeDocument || !iframeDocument.body) return;

                if (state.observer) {
                    state.observer.disconnect();
                }

                state.observer = new MutationObserver((mutations) => {
                    let shouldProcess = false;
                    for (const mutation of mutations) {
                        if (mutation.type === 'childList') {
                            for (const node of mutation.addedNodes) {
                                if (hasMatchingLinks(node, PC_ARTICLE_LINK_SELECTOR)) {
                                    shouldProcess = true;
                                    break;
                                }
                            }
                        }
                        if (shouldProcess) break;
                    }
                    if (shouldProcess && extensionStatus > EXTENSION_STATUS.DISABLED) {
                        debouncedProcessLinks();
                    }
                });

                state.observer.observe(iframeDocument.body, {
                    childList: true,
                    subtree: true
                });
                iframeObservers.push(state.observer);
            } catch (error) {
                // Ignore inaccessible cross-origin iframes
            }
        };

        state = { observer: null, observeCurrentDocument, processLinks };
        iframeStateMap.set(iframe, state);

        iframe.addEventListener('load', () => {
            if (extensionStatus === EXTENSION_STATUS.DISABLED) return;
            state.observeCurrentDocument();
            state.processLinks();
        });
    }

    state.observeCurrentDocument();
    state.processLinks();
};

const stopContentScript = () => {
    if (mainObserver) {
        mainObserver.disconnect();
        mainObserver = null;
    }
    iframeObservers.forEach(observer => observer.disconnect());
    iframeObservers = [];
};

// Extension status management
const updateExtensionStatus = (status) => {
    extensionStatus = status;
    if (extensionStatus > EXTENSION_STATUS.DISABLED) {
        initContentScript();
    } else {
        activeTasks = 0;
        stopContentScript();
    }
    updateIconStatus(status);
};

// Initialization
const initializeExtension = () => {
    chrome.storage.local.get(['enabled'], result => {
        updateExtensionStatus(result.enabled || EXTENSION_STATUS.DISABLED);
    });
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeExtension, { once: true });
} else {
    initializeExtension();
}

window.addEventListener('popstate', () => {
    setTimeout(() => {
        if (extensionStatus > EXTENSION_STATUS.DISABLED) {
            replaceSpyLinks(document);
        }
    }, 500);
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'updateStatus') {
        updateExtensionStatus(request.enabled);
        sendResponse({
            success: true
        });
    }
    return true;
});