(() => {
    const EVENT_NAME = '__nspy_api_meta__';

    const emit = (payload) => {
        try {
            const detail = JSON.stringify(payload);
            const targetDoc = (() => {
                try {
                    return window.top?.document || document;
                } catch {
                    return document;
                }
            })();
            targetDoc.dispatchEvent(new CustomEvent(EVENT_NAME, { detail }));
        } catch {
            // Ignore dispatch errors
        }
    };

    const isTargetUrl = (url) => {
        if (!url || typeof url !== 'string') return false;
        return url.includes('/cafe-home/v1/member/identifier') ||
            url.includes('/cafe-cafeinfo-api/') ||
            url.includes('/cafe-cafemain-api/') ||
            url.includes('/CafeMemberInfo.json') ||
            url.includes('/cafe-boardlist-api/') ||
            url.includes('/search/v') ||
            url.includes('/ArticleListV');
    };

    const emitArticles = (list, fallbackCafeId) => {
        if (!Array.isArray(list)) return;
        const articles = [];
        for (const entry of list) {
            const it = entry?.item || entry;
            if (!it || it.articleId == null) continue;
            const rawReadLevel = it.readLevel ?? it.cafeMenuReadLevel;
            articles.push({
                articleId: String(it.articleId),
                cafeId: String(it.cafeId || fallbackCafeId),
                readLevel: typeof rawReadLevel === 'number' ? rawReadLevel : null,
                openArticle: Boolean(it.openArticle),
                self: Boolean(it.self),
                hasSummary: Boolean(it.summary && String(it.summary).trim().length > 0)
            });
        }
        if (articles.length > 0) {
            emit({ type: 'articles', articles });
        }
    };

    const inspectPayload = (url, status, json) => {
        try {
            if (url.includes('/cafe-home/v1/member/identifier')) {
                const loggedIn = json?.message?.result?.loggedIn;
                if (typeof loggedIn === 'boolean') {
                    emit({ type: 'auth', loggedIn });
                }
                return;
            }

            const memberMatch = url.match(/\/cafes\/(\d+)\/(?:members|my)(?:\?|$)/);
            if (memberMatch && (url.includes('/cafe-cafeinfo-api/') || url.includes('/cafe-cafemain-api/'))) {
                const cafeId = memberMatch[1];
                const res = json?.result;
                if (res && status >= 200 && status < 300) {
                    const rawLevel = res.memberLevel;
                    const level = typeof rawLevel === 'object'
                        ? Number(rawLevel?.id ?? rawLevel?.level ?? 0)
                        : (Number(rawLevel) || 0);
                    const isStaff = Boolean(
                        res.role?.isEntireBoardStaff ||
                        res.manager ||
                        res.staff ||
                        level >= 999
                    );
                    emit({ type: 'member', cafeId, isMember: true, level, isStaff });
                } else {
                    const errCode = String(json?.errorCode || json?.error?.errorCode || '');
                    if (status === 401 || status === 403 || errCode === '10004' || errCode === '40003') {
                        emit({ type: 'member', cafeId, isMember: false, level: 0, isStaff: false });
                    }
                }
                return;
            }

            if (url.includes('/CafeMemberInfo.json')) {
                const urlObj = new URL(url, location.origin);
                const res = json?.message?.result;
                const cafeId = urlObj.searchParams.get('cafeId') || (res?.cafeId ? String(res.cafeId) : '');
                if (cafeId && res) {
                    emit({
                        type: 'member',
                        cafeId,
                        isMember: Boolean(res.cafeMember),
                        level: Number(res.memberLevel) || 0,
                        isStaff: Boolean(res.cafeManager || res.viceManager || res.cafeStaff || res.entireBoardStaff)
                    });
                }
                return;
            }

            if ((url.includes('/cafe-boardlist-api/') || url.includes('/search/v')) && url.includes('/articles')) {
                const cafeMatch = url.match(/\/cafes\/(\d+)\//);
                emitArticles(json?.result?.articleList, cafeMatch ? cafeMatch[1] : '');
                return;
            }

            if (url.includes('/ArticleListV')) {
                const res = json?.message?.result;
                const fallbackCafeId = res?.cafeId ? String(res.cafeId) : '';
                if (fallbackCafeId && res?.cafeStaff === true) {
                    emit({ type: 'member', cafeId: fallbackCafeId, isMember: true, level: 999, isStaff: true });
                } else if (fallbackCafeId && res?.cafeMember === false) {
                    emit({ type: 'member', cafeId: fallbackCafeId, isMember: false, level: 0, isStaff: false });
                }
                emitArticles(res?.articleList, fallbackCafeId);
            }
        } catch {
            // Never disrupt page execution
        }
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__nspyUrl = typeof url === 'string' ? url : String(url || '');
        return origOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (...args) {
        if (isTargetUrl(this.__nspyUrl)) {
            this.addEventListener('load', function () {
                try {
                    if (this.responseType && this.responseType !== 'text' && this.responseType !== 'json') return;
                    const json = this.responseType === 'json'
                        ? this.response
                        : JSON.parse(this.responseText);
                    inspectPayload(this.__nspyUrl, this.status, json);
                } catch {
                    // Ignore non-JSON responses
                }
            });
        }
        return origSend.apply(this, args);
    };

    if (typeof window.fetch === 'function') {
        const origFetch = window.fetch;
        window.fetch = function (input, init) {
            const url = typeof input === 'string' ? input : (input?.url || '');
            const promise = origFetch.call(this, input, init);
            if (isTargetUrl(url)) {
                promise.then((resp) => {
                    resp.clone().json()
                        .then((json) => inspectPayload(url, resp.status, json))
                        .catch(() => {});
                }).catch(() => {});
            }
            return promise;
        };
    }
})();
