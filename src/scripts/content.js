// Constants
const EXTENSION_STATUS = {
    DISABLED: 1,
    ENABLED: 2,
    RUNNING: 3
};

// State
let extensionStatus = EXTENSION_STATUS.DISABLED;
const processedLinks = new Set();
let mainObserver;
let iframeObservers = [];

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
    chrome.runtime.sendMessage({
        action: 'updateIconStatus',
        status
    });
};

// Core functions
const fetchNewUrl = async (articleId, title, cafeName) => {
    const encodedTitle = encodeURIComponent(title);
    const searchUrl = `https://search.naver.com/search.naver?ssc=tab.cafe.all&query=${encodedTitle}`;

    try {
        const response = await chrome.runtime.sendMessage({
            action: 'fetchUrl',
            url: searchUrl
        });
        if (response.error) throw new Error(response.error);

        const parser = new DOMParser();
        const doc = parser.parseFromString(response.data, 'text/html');
        const detailBoxes = doc.querySelectorAll('div.detail_box a.title_link');

        for (const link of detailBoxes) {
            const url = new URL(link.href);
            const urlCafeName = url.pathname.split('/')[1];
            const urlArticleId = url.pathname.split('/')[2];
            if (urlArticleId === articleId && urlCafeName === cafeName) {
                return url.searchParams.get('art');
            }
        }
    } catch (error) {
    }

    return null;
};

const replaceSpyLinks = async (doc) => {
    if (extensionStatus !== EXTENSION_STATUS.ENABLED) return;
    updateIconStatus(EXTENSION_STATUS.RUNNING);

    if (doc.readyState !== 'complete' && doc.readyState !== 'interactive') {
        await new Promise(resolve => doc.addEventListener('DOMContentLoaded', resolve));
    }

    const articleLinks = doc.querySelectorAll('a.article');
    if (articleLinks.length === 0) {
        updateIconStatus(EXTENSION_STATUS.ENABLED);
        return;
    }

    const cafeName = extractCafeName(doc);

    const promises = Array.from(articleLinks).map(async (link) => {
        if (processedLinks.has(link.href)) return;

        processedLinks.add(link.href);
        const url = new URL(link.href);
        const cafeId = url.searchParams.get('clubid');
        const articleId = url.searchParams.get('articleid');
        const title = extractTitle(link);

        const art = await fetchNewUrl(articleId, title, cafeName);
        if (art) {
            url.searchParams.set('art', art);
            link.href = url.toString();
        }
    });

    await Promise.all(promises);
    updateIconStatus(EXTENSION_STATUS.ENABLED);
};

const extractCafeName = (doc) => {
    const scriptTags = doc.querySelectorAll('script[type="text/javascript"]');
    for (const script of scriptTags) {
        const match = script.textContent.match(/sCafeUrl\s*:\s*"([^"]+)"/);
        if (match) return match[1];
    }
    return '';
};

const extractTitle = (link) => {
    const headSpan = link.querySelector('span.head');
    return headSpan ?
        [...link.childNodes].filter(node => node !== headSpan).map(node => node.textContent.trim()).join(' ') :
        link.textContent.trim();
};

// Observer functions
const initContentScript = () => {
    if (extensionStatus === EXTENSION_STATUS.DISABLED) return;

    mainObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.type === 'childList') {
                mutation.addedNodes.forEach(node => {
                    if (node.tagName === 'IFRAME') {
                        handleIframeChanges(node);
                    }
                });
            }
        }
    });

    mainObserver.observe(document.body, {
        childList: true,
        subtree: true
    });

    document.querySelectorAll('iframe').forEach(handleIframeChanges);

    processedLinks.clear();
    replaceSpyLinks(document);
};

const handleIframeChanges = (iframe) => {
    if (extensionStatus === EXTENSION_STATUS.DISABLED) return;

    const processLinks = () => {
        try {
            const iframeDocument = iframe.contentDocument || iframe.contentWindow.document;
            if (iframeDocument) {
                processedLinks.clear();
                replaceSpyLinks(iframeDocument);
            }
        } catch (error) {
            console.error('Error processing iframe:', error);
        }
    };

    const debouncedProcessLinks = debounce(processLinks, 500);

    iframe.addEventListener('load', processLinks);

    const observer = new MutationObserver(debouncedProcessLinks);

    try {
        observer.observe(iframe.contentDocument || iframe.contentWindow.document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['href']
        });
        iframeObservers.push(observer);
    } catch (error) {
        console.error('Error observing iframe:', error);
    }
};

const stopContentScript = () => {
    if (mainObserver) {
        mainObserver.disconnect();
    }
    iframeObservers.forEach(observer => observer.disconnect());
    iframeObservers = [];
    processedLinks.clear();
};

// Extension status management
const updateExtensionStatus = (status) => {
    extensionStatus = status;
    if (extensionStatus > EXTENSION_STATUS.DISABLED) {
        initContentScript();
    } else {
        stopContentScript();
    }
    updateIconStatus(status);
};

// Initialize
chrome.storage.local.get(['enabled'], result => {
    updateExtensionStatus(result.enabled);
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

window.addEventListener('load', () => {
    chrome.storage.local.get(['enabled'], result => {
        updateExtensionStatus(result.enabled);
    });
});