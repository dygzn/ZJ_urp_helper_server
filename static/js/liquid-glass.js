/* Decorative material lighting only; no business state or API requests. */
(function () {
    'use strict';
    const root = document.documentElement;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const reducedTransparency = window.matchMedia('(prefers-reduced-transparency: reduce)');
    const hover = window.matchMedia('(hover: hover) and (pointer: fine)');
    const surfaces = '.event-card, .home-shortcuts button, .home-secondary-shortcuts button, .grade-action-btn, .appearance-trigger, .btn-secondary, .config-section, .campaign-card';
    let current = null;
    let frame = null;
    let pointer = null;

    function clearLight() {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        if (current) {
            current.style.removeProperty('--glass-light-x');
            current.style.removeProperty('--glass-light-y');
        }
        current = null;
    }

    function init() {
        const scene = document.createElement('div');
        scene.className = 'liquid-glass-scene';
        scene.setAttribute('aria-hidden', 'true');
        document.body.prepend(scene);

        document.addEventListener('pointermove', event => {
            if (root.dataset.uiTemplate !== 'glass' || !hover.matches || reduced.matches || reducedTransparency.matches || event.pointerType === 'touch') return;
            const target = event.target.closest?.(surfaces);
            if (target !== current) clearLight();
            if (!target) return;
            current = target;
            pointer = { x: event.clientX, y: event.clientY };
            if (frame !== null) return;
            frame = requestAnimationFrame(() => {
                frame = null;
                if (!current?.isConnected) return clearLight();
                const bounds = current.getBoundingClientRect();
                current.style.setProperty('--glass-light-x', `${((pointer.x - bounds.left) / bounds.width * 100).toFixed(1)}%`);
                current.style.setProperty('--glass-light-y', `${((pointer.y - bounds.top) / bounds.height * 100).toFixed(1)}%`);
            });
        }, { passive: true });
        document.addEventListener('pointerleave', clearLight);
        reduced.addEventListener('change', clearLight);
        reducedTransparency.addEventListener('change', clearLight);
        hover.addEventListener('change', clearLight);
        new MutationObserver(clearLight).observe(root, { attributes: true, attributeFilter: ['data-ui-template'] });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
})();
