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
const fetchNewUrl = async (isMobile, articleId, title, cafeName) => {
    const encodedTitle = encodeURIComponent(title);
    let searchUrl;
    if (isMobile) {
        searchUrl = `https://m.search.naver.com/search.naver?ssc=tab.cafe.all&query="${encodedTitle}"`;
    } else {
        searchUrl = `https://search.naver.com/search.naver?ssc=tab.cafe.all&query="${encodedTitle}"`;
    }

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

const cafeInfoCache = new Map();

const fetchCafeInfoFromUrl = async (cafeUrl) => {
    if (cafeInfoCache.has(cafeUrl)) {
        return cafeInfoCache.get(cafeUrl);
    }

    const apiUrl = `https://apis.naver.com/cafe-web/cafe2/CafeGateInfo.json?cluburl=${cafeUrl}`;
    try {
        const response = await fetch(apiUrl, {
            credentials: 'include',
            headers: { 'Accept': 'application/json' }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const json = await response.json();
        const cafeInfo = json?.message?.result?.cafeInfoView;
        if (!cafeInfo?.cafeId) throw new Error('cafeId not found');

        const result = {
            cafeName: cafeInfo.cafeUrl,
            cafeIndex: cafeInfo.cafeId.toString()
        };

        cafeInfoCache.set(cafeUrl, result);
        return result;
    } catch (err) {
        return null;
    }
};

const waitForElement = (selector, timeout = 5000) => {
    return new Promise((resolve, reject) => {
        const element = document.querySelector(selector);
        if (element) return resolve(element);

        const observer = new MutationObserver((mutations) => {
            const el = document.querySelector(selector);
            if (el) {
                observer.disconnect();
                resolve(el);
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        setTimeout(() => {
            observer.disconnect();
            reject(new Error('Timeout waiting for element: ' + selector));
        }, timeout);
    });
};

const replaceSpyLinks = async (doc) => {
    if (extensionStatus !== EXTENSION_STATUS.ENABLED) return;
    updateIconStatus(EXTENSION_STATUS.RUNNING);

    if (doc.readyState !== 'complete' && doc.readyState !== 'interactive') {
        await new Promise(resolve => doc.addEventListener('DOMContentLoaded', resolve));
    }

    const isMobile = /Mobi|Android/i.test(navigator.userAgent);

    if (isMobile) {        
        const pathParts = location.pathname.split('/');
        const cafeUrl = pathParts[2];

        const cafeInfo = await fetchCafeInfoFromUrl(cafeUrl);
        if (cafeInfo) {
            const { cafeName, cafeIndex } = cafeInfo;
            try {
                await waitForElement('a.mainLink');
            } catch (e) {
                updateIconStatus(EXTENSION_STATUS.ENABLED);
                return;
            }

            const articleLinks = doc.querySelectorAll('a.mainLink');
            const promises = Array.from(articleLinks).map(async (link) => {
                const href = link.href;

                if (processedLinks.has(href)) return;
                processedLinks.add(href);

                const url = new URL(href);
                const articleId = url.searchParams.get('articleid');
                const titleSpan = link.querySelector('span.tit');
                const title = titleSpan ? titleSpan.textContent.trim() : '';

                const art = await fetchNewUrl(isMobile, articleId, title, cafeName);
                if (art) {
                    url.searchParams.set('art', art);
                    const newUrl = url.toString();
                    link.href = newUrl;

                    link.addEventListener('click', (e) => {
                        e.preventDefault();
                        window.location.replace(newUrl);
                    });
                }
            });

            await Promise.all(promises);
        }
    } else {
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
            const pathParts = url.pathname.split('/');
            let cafeId = null;
            let articleId = null;
            
            const cafeIndex = pathParts.indexOf('cafes');
            const articleIndex = pathParts.indexOf('articles');

            if (cafeIndex !== -1 && pathParts.length > cafeIndex + 1) {
                cafeId = pathParts[cafeIndex + 1];
            }
            if (articleIndex !== -1 && pathParts.length > articleIndex + 1) {
                articleId = pathParts[articleIndex + 1];
            }
            const title = extractTitle(link);

            const art = await fetchNewUrl(isMobile, articleId, title, cafeName);
            if (art) {
                const newUrl = `https://cafe.naver.com/${cafeName}/${articleId}?art=${encodeURIComponent(art)}`;
                link.href = newUrl;

                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    window.location.href = newUrl;
                });
            }
        });

        await Promise.all(promises);
    }
    updateIconStatus(EXTENSION_STATUS.ENABLED);
};

const extractCafeName = (doc) => {
    const scriptTags = doc.querySelectorAll('script');
    for (const script of scriptTags) {
        const text = script.textContent;
        const match = text.match(/\\"cafeUrl\\":\\"([^"]+)\\"/);
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

    const debouncedReplaceLinks = debounce(() => {
        if (extensionStatus > EXTENSION_STATUS.DISABLED) {
            replaceSpyLinks(document);
        }
    }, 1000);

    mainObserver = new MutationObserver((mutations) => {
        let shouldProcessLinks = false;
        
        for (const mutation of mutations) {
            if (mutation.type === 'childList') {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        if (node.tagName === 'IFRAME') {
                            handleIframeChanges(node);
                        }
                        // Check if new article links were added
                        if (node.querySelector && node.querySelector('a.article')) {
                            shouldProcessLinks = true;
                        }
                        // Check if the node itself is an article link
                        if (node.matches && node.matches('a.article')) {
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

// initialization
const initializeExtension = () => {
    chrome.storage.local.get(['enabled'], result => {
        updateExtensionStatus(result.enabled || EXTENSION_STATUS.DISABLED);
    });
};

// Initialize immediately if DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeExtension);
} else {
    initializeExtension();
}

// Additional event listeners for navigation
window.addEventListener('load', initializeExtension);
window.addEventListener('popstate', () => {
    setTimeout(() => {
        if (extensionStatus > EXTENSION_STATUS.DISABLED) {
            processedLinks.clear();
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