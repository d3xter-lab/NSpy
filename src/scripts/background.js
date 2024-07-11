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

const fetchUrl = async (url) => {
    const headers = {
        'Content-Type': url.includes('search.naver.com') ? 'text/html' : 'application/json'
    };

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers
        });
        return await response.text();
    } catch (error) {
        throw error;
    }
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