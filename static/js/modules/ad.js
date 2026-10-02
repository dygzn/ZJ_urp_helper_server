import { pageResources } from './lifecycle.js';
import { state } from './store.js';
const resources = pageResources('ad');

export const headerAdNeverShowKey = 'urp_header_ad_never_show';

export const headerAdDismissedKey = 'urp_header_ad_dismissed';

export const boundUsernameStorageKey = 'urp_bound_username';

export function trackHeaderAdEvent(eventName) {
    resources.fetch('/api/ad/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: eventName }),
        keepalive: true,
    }).catch(() => {});
}

export function headerAdStorageHas(storage, key) {
    try {
        return storage.getItem(key) === '1';
    } catch (error) {
        if (error?.name === 'AbortError') return;
        return false;
    }
}

export function renderHeaderAd() {
    const slot = document.getElementById('header-ad-slot');
    const card = document.getElementById('header-ad-card');
    const detail = document.getElementById('header-ad-detail');
    const optionsButton = document.querySelector('.header-ad-options');
    const restoreButton = document.getElementById('header-ad-restore');
    if (!slot || !card || !detail || !optionsButton || !restoreButton) return;

    const neverShow = headerAdStorageHas(localStorage, headerAdNeverShowKey);
    const dismissed = !neverShow && headerAdStorageHas(sessionStorage, headerAdDismissedKey);

    slot.hidden = neverShow;
    card.hidden = dismissed;
    restoreButton.hidden = !dismissed;
    detail.hidden = true;
    optionsButton.setAttribute('aria-expanded', 'false');

    if (!neverShow && !dismissed && !state.headerAdImpressionTracked) {
        state.headerAdImpressionTracked = true;
        trackHeaderAdEvent('impression');
    }
}

export function handleHeaderAdAction(action) {
    const detail = document.getElementById('header-ad-detail');
    const optionsButton = document.querySelector('.header-ad-options');
    if (!detail || !optionsButton) return;

    if (action === 'options' || action === 'detail') {
        const isExpanded = !detail.hidden;
        detail.hidden = isExpanded;
        optionsButton.setAttribute('aria-expanded', String(!isExpanded));
        return;
    }

    if (action === 'dismiss') {
        trackHeaderAdEvent('dismiss');
        try {
            sessionStorage.setItem(headerAdDismissedKey, '1');
        } catch (error) {
        if (error?.name === 'AbortError') return;
            // 存储不可用时仍允许当前页面关闭广告。
        }
        renderHeaderAd();
        return;
    }

    if (action === 'never-show') {
        trackHeaderAdEvent('dismiss');
        try {
            localStorage.setItem(headerAdNeverShowKey, '1');
            sessionStorage.removeItem(headerAdDismissedKey);
        } catch (error) {
        if (error?.name === 'AbortError') return;
            // 存储不可用时不阻断网站其他功能。
        }
        renderHeaderAd();
        return;
    }

    if (action === 'restore') {
        try {
            sessionStorage.removeItem(headerAdDismissedKey);
        } catch (error) {
        if (error?.name === 'AbortError') return;
            // 存储不可用时无需阻断恢复按钮。
        }
        renderHeaderAd();
    }
}

export function initializeHeaderAd() {
    const slot = document.getElementById('header-ad-slot');
    if (!slot) return;

    slot.addEventListener('click', function(event) {
        const target = event.target instanceof Element
            ? event.target.closest('[data-ad-action]')
            : null;
        if (!target) return;
        handleHeaderAdAction(target.dataset.adAction);
    });
    renderHeaderAd();
}
