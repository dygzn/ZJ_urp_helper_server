(function(root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.AdDetailUI = api;
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function(root) {
    function resolveCopyText(copyTextFn) {
        if (typeof copyTextFn === 'function') return copyTextFn;
        if (root.ServiceStatusUI && typeof root.ServiceStatusUI.copyText === 'function') {
            return root.ServiceStatusUI.copyText;
        }
        return async function() { return false; };
    }

    function resolveTrackEvent(trackEventFn) {
        if (typeof trackEventFn === 'function') return trackEventFn;
        if (typeof root.fetch === 'function') {
            return function(eventName) {
                const payload = { event: eventName };
                if (eventName === 'copy') {
                    try {
                        const username = String(
                            root.localStorage?.getItem('urp_bound_username') || '',
                        ).trim();
                        if (username) payload.username = username;
                    } catch (error) {
                        // 本地存储不可用时仍正常记录匿名复制次数。
                    }
                }
                root.fetch('/api/ad/event', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    keepalive: true,
                }).catch(() => {});
            };
        }
        return function() {};
    }

    async function copyAdDetailValue(button, feedback, copyTextFn, trackEventFn) {
        const value = button?.dataset?.copyValue || '';
        let copied = false;

        try {
            copied = await resolveCopyText(copyTextFn)(value) === true;
        } catch (error) {
            copied = false;
        }

        const label = button?.querySelector?.('[data-copy-label]');
        const originalLabel = label?.textContent || '';
        const message = copied
            ? (button?.dataset?.copySuccess || `已复制 ${value}`)
            : '复制失败，请长按复制';
        button?.setAttribute?.('data-copy-state', copied ? 'copied' : 'failed');
        if (label) {
            label.textContent = copied ? '已复制联系信息' : '复制失败，请长按复制';
        }
        if (feedback) {
            feedback.textContent = message;
        }
        if (copied) {
            try {
                resolveTrackEvent(trackEventFn)('copy');
            } catch (error) {
                // 统计失败不能影响已经完成的复制操作。
            }
        }

        if (label) {
            const schedule = typeof root.setTimeout === 'function'
                ? root.setTimeout.bind(root)
                : null;
            if (schedule) {
                schedule(() => {
                    if (button?.isConnected !== false && label.isConnected !== false) {
                        label.textContent = originalLabel;
                    }
                }, 1800);
            }
        }

        return { copied, value, message };
    }

    function initializeAdDetailCopy(documentObject, copyTextFn, trackEventFn) {
        if (!documentObject || typeof documentObject.querySelector !== 'function') return false;

        const copyRoot = documentObject.querySelector('[data-ad-copy-root]');
        const feedback = documentObject.querySelector('[data-copy-feedback]');
        if (!copyRoot || typeof copyRoot.querySelectorAll !== 'function') return false;

        const buttons = copyRoot.querySelectorAll('[data-copy-value]');
        buttons.forEach(button => {
            if (typeof button.addEventListener !== 'function') return;
            button.addEventListener('click', function() {
                void copyAdDetailValue(button, feedback, copyTextFn, trackEventFn);
            });
        });
        return buttons.length > 0;
    }

    function initializeStickyContactAction(documentObject, observerFactory) {
        if (!documentObject || typeof documentObject.querySelector !== 'function') return false;

        const heroButton = documentObject.querySelector('.ad-detail-hero-copy');
        const stickyButton = documentObject.querySelector('.ad-detail-sticky-cta');
        if (!heroButton || !stickyButton) return false;

        stickyButton.hidden = true;
        const createObserver = typeof observerFactory === 'function'
            ? observerFactory
            : (typeof root.IntersectionObserver === 'function'
                ? (callback => new root.IntersectionObserver(callback, { threshold: 0.2 }))
                : null);

        if (!createObserver) {
            stickyButton.hidden = false;
            return true;
        }

        const observer = createObserver(entries => {
            const heroEntry = entries.find(entry => entry.target === heroButton) || entries[0];
            if (heroEntry) stickyButton.hidden = heroEntry.isIntersecting;
        });
        observer.observe(heroButton);
        return true;
    }

    function cleanAdDetailSource(windowObject) {
        if (!windowObject?.location?.href || !windowObject?.history?.replaceState) return false;
        try {
            const currentUrl = new URL(windowObject.location.href);
            if (currentUrl.searchParams.get('source') !== 'header') return false;
            currentUrl.searchParams.delete('source');
            const query = currentUrl.searchParams.toString();
            const cleanUrl = `${currentUrl.pathname}${query ? `?${query}` : ''}${currentUrl.hash}`;
            windowObject.history.replaceState(windowObject.history.state || null, '', cleanUrl);
            return true;
        } catch (error) {
            return false;
        }
    }

    if (typeof document !== 'undefined') {
        const initialize = () => {
            cleanAdDetailSource(root);
            initializeAdDetailCopy(document);
            initializeStickyContactAction(document);
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initialize, { once: true });
        } else {
            initialize();
        }
    }

    return {
        copyAdDetailValue,
        cleanAdDetailSource,
        initializeAdDetailCopy,
        initializeStickyContactAction,
    };
}));
