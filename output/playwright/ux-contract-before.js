(() => {
    const isVisible = element => {
        if (!element || element.hidden) return false;
        const style = window.getComputedStyle(element);
        return style.display !== 'none'
            && style.visibility !== 'hidden'
            && element.getClientRects().length > 0;
    };

    const controls = [...document.querySelectorAll(
        '#sidebar .nav-item, #sidebar .close-btn, #menu-trigger, '
        + '.header-ad-options, .header-ad-close, .refresh-btn, '
        + '.modal-close, button, a, input, select, textarea',
    )].filter(isVisible);

    const failures = controls
        .map(element => ({
            label: element.getAttribute('aria-label') || element.textContent.trim().slice(0, 30),
            width: Math.round(element.getBoundingClientRect().width),
            height: Math.round(element.getBoundingClientRect().height),
        }))
        .filter(rect => rect.width < 44 || rect.height < 44);

    return {
        failures,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
})();

