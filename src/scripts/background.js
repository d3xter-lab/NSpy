// Constants
const EXTENSION_STATUS = {
    DISABLED: 1,
    ENABLED: 2,
    RUNNING: 3
};

// Utility functions
const setIcon = (status) => {
    const prefix = status === EXTENSION_STATUS.DISABLED ? "icon_disabled_" :
        status === EXTENSION_STATUS.RUNNING ? "icon_running_" : "icon_";

    chrome.action.setIcon({
        path: {
            16: `/images/${prefix}16.png`,
            32: `/images/${prefix}32.png`,
            48: `/images/${prefix}48.png`,
            128: `/images/${prefix}128.png`
        }
    });
};

const SEARCH_CONCURRENCY = 2;
const SEARCH_DELAY_MS = 180;
let activeSearchCount = 0;
let lastSearchStartTime = 0;
const searchQueue = [];

const scheduleSearchFetch = (task) => {
    return new Promise((resolve, reject) => {
        searchQueue.push({ task, resolve, reject });
        drainSearchQueue();
    });
};

const drainSearchQueue = () => {
    if (activeSearchCount >= SEARCH_CONCURRENCY || searchQueue.length === 0) return;

    const now = Date.now();
    const waitMs = Math.max(0, lastSearchStartTime + SEARCH_DELAY_MS - now);
    activeSearchCount++;
    lastSearchStartTime = now + waitMs;

    const { task, resolve, reject } = searchQueue.shift();
    setTimeout(async () => {
        try {
            resolve(await task());
        } catch (err) {
            reject(err);
        } finally {
            activeSearchCount--;
            drainSearchQueue();
        }
    }, waitMs);
};

const fetchUrl = async (url) => {
    const isSearch = url.includes('search.naver.com');
    const headers = {
        'Accept': isSearch
            ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            : 'application/json'
    };

    const doFetch = async () => {
        const response = await fetch(url, {
            method: 'GET',
            headers
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        return await response.text();
    };

    return isSearch ? scheduleSearchFetch(doFetch) : doFetch();
};

const updateAllTabs = (enabled) => {
    chrome.tabs.query({}, (tabs) => {
        tabs.forEach((tab) => {
            chrome.tabs.sendMessage(tab.id, {
                action: "updateStatus",
                enabled: enabled
            }, () => {
                if (chrome.runtime.lastError) {
                    // Ignore errors from inactive tabs
                }
            });
        });
    });
};

// Message handlers
const handleFetchUrl = async (request, sendResponse) => {
    try {
        const data = await fetchUrl(request.url);
        sendResponse({
            data
        });
    } catch (error) {
        sendResponse({
            error: error.message
        });
    }
};

const handleUpdateStatus = (request, sendResponse) => {
    chrome.storage.local.set({
        enabled: request.enabled
    }, () => {
        setIcon(request.enabled);
        updateAllTabs(request.enabled);
        sendResponse({
            success: true
        });
    });
};

const handleUpdateIconStatus = (request, sendResponse) => {
    setIcon(request.status);
    sendResponse({
        success: true
    });
};

// Event listeners
chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === "install") {
        chrome.storage.local.set({
            enabled: EXTENSION_STATUS.DISABLED
        }, () => {
            setIcon(EXTENSION_STATUS.DISABLED);
        });
    } else if (details.reason === "update") {
        chrome.storage.local.get("enabled", (items) => {
            const status = typeof items.enabled === "undefined" ? EXTENSION_STATUS.DISABLED : items
                .enabled;
            chrome.storage.local.set({
                enabled: status
            }, () => {
                setIcon(status);
            });
        });
    }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {
        case 'fetchUrl':
            handleFetchUrl(request, sendResponse);
            return true;
        case 'updateStatus':
            handleUpdateStatus(request, sendResponse);
            return true;
        case 'updateIconStatus':
            handleUpdateIconStatus(request, sendResponse);
            return true;
        default:
            console.warn('Unknown action:', request.action);
            return false;
    }
});