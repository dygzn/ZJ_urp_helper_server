/* Theme-specific navigation enhancement. Existing click handlers own page changes. */
(function () {
    'use strict';

    function init() {
        const nav = document.getElementById('mobile-bottom-nav');
        if (!nav) return;
        const root = document.documentElement;
        const mobile = window.matchMedia('(max-width: 768px)');
        const items = Array.from(nav.querySelectorAll('.mobile-nav-item'));
        const lens = document.createElement('span');
        lens.className = 'mobile-nav-lens';
        lens.setAttribute('aria-hidden', 'true');
        nav.append(lens);

        let enabled = false;
        let gesture = null;
        let frame = null;
        let readyFrame = null;
        let pending = null;
        let suppressClickUntil = 0;

        function activeIndex() {
            const more = items.findIndex(item => item.getAttribute('aria-expanded') === 'true');
            if (more >= 0) return more;
            const active = items.findIndex(item => item.classList.contains('active'));
            return active >= 0 ? active : 0;
        }

        function placeLens(x, width) {
            nav.style.setProperty('--nav-lens-x', `${x.toFixed(2)}px`);
            nav.style.setProperty('--nav-lens-width', `${width.toFixed(2)}px`);
        }

        function syncSelection() {
            if (!enabled || gesture?.dragging) return;
            const bounds = nav.getBoundingClientRect();
            const selected = items[activeIndex()]?.getBoundingClientRect();
            if (bounds.width && selected?.width) placeLens(selected.left - bounds.left, selected.width);
        }

        function resetGesture(restore = true) {
            const previous = gesture;
            gesture = null;
            if (frame !== null) cancelAnimationFrame(frame);
            frame = null;
            pending = null;
            nav.classList.remove('is-nav-dragging');
            nav.removeAttribute('data-nav-preview');
            nav.removeAttribute('data-nav-outside');
            if (previous?.captured && nav.hasPointerCapture(previous.pointerId)) nav.releasePointerCapture(previous.pointerId);
            if (restore) syncSelection();
        }

        function cancelGesture() {
            if (gesture) suppressClickUntil = performance.now() + 500;
            resetGesture();
        }

        function syncAvailability() {
            cancelGesture();
            if (readyFrame !== null) {
                cancelAnimationFrame(readyFrame);
                readyFrame = null;
            }
            enabled = root.dataset.uiTemplate === 'glass' && mobile.matches;
            nav.classList.toggle('has-nav-lens', enabled);
            nav.dataset.navLensReady = 'false';
            if (!enabled) {
                nav.style.removeProperty('--nav-lens-x');
                nav.style.removeProperty('--nav-lens-width');
                return;
            }
            syncSelection();
            readyFrame = requestAnimationFrame(() => {
                readyFrame = null;
                if (enabled) nav.dataset.navLensReady = 'true';
            });
        }

        function isInside(point, bounds) {
            return point.x >= bounds.left - 12 && point.x <= bounds.right + 12
                && point.y >= bounds.top - 12 && point.y <= bounds.bottom + 12;
        }

        function renderDrag(point) {
            if (!gesture?.dragging) return;
            const { bounds, positions } = gesture;
            let nearest = 0;
            positions.forEach((position, index) => {
                if (Math.abs(point.x - position.center) < Math.abs(point.x - positions[nearest].center)) nearest = index;
            });
            gesture.targetIndex = nearest;
            const width = positions[nearest].width;
            const minimum = positions[0].left - bounds.left;
            const maximum = positions[positions.length - 1].right - bounds.left - width;
            placeLens(Math.min(maximum, Math.max(minimum, point.x - bounds.left - width / 2)), width);
            nav.dataset.navPreview = String(nearest);
            nav.dataset.navOutside = String(!isInside(point, bounds));
        }

        nav.addEventListener('pointerdown', event => {
            if (event.isPrimary === false || gesture
                || (event.pointerType === 'mouse' && event.button !== 0)) return;
            // Every fresh press starts a new click, even after switching to the simple theme.
            suppressClickUntil = 0;
            if (!enabled || document.querySelector('dialog[open], .modal.active, .sidebar.active')) return;
            const bounds = nav.getBoundingClientRect();
            gesture = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                dragging: false,
                captured: false,
                targetIndex: activeIndex(),
                bounds,
                positions: items.map(item => {
                    const rect = item.getBoundingClientRect();
                    return { left: rect.left, right: rect.right, width: rect.width, center: rect.left + rect.width / 2 };
                }),
            };
        });

        document.addEventListener('pointerdown', event => {
            if (gesture && event.pointerId !== gesture.pointerId) cancelGesture();
        }, true);

        nav.addEventListener('pointermove', event => {
            if (!gesture || gesture.pointerId !== event.pointerId) return;
            const deltaX = event.clientX - gesture.startX;
            const deltaY = event.clientY - gesture.startY;
            if (!gesture.dragging) {
                if (Math.abs(deltaY) > 14 && Math.abs(deltaY) > Math.abs(deltaX)) return cancelGesture();
                if (Math.abs(deltaX) < 6) return;
                gesture.dragging = true;
                nav.classList.add('is-nav-dragging');
                try {
                    nav.setPointerCapture(event.pointerId);
                    gesture.captured = true;
                } catch (_) {
                    return cancelGesture();
                }
            }
            if (event.cancelable) event.preventDefault();
            pending = { x: event.clientX, y: event.clientY };
            if (frame !== null) return;
            frame = requestAnimationFrame(() => {
                frame = null;
                if (pending) renderDrag(pending);
            });
        }, { passive: false });

        document.addEventListener('pointerup', event => {
            if (!gesture || gesture.pointerId !== event.pointerId) return;
            if (!gesture.dragging) return resetGesture();
            const point = { x: event.clientX, y: event.clientY };
            renderDrag(point);
            const target = items[gesture.targetIndex];
            const shouldActivate = isInside(point, gesture.bounds);
            const current = items[activeIndex()];
            suppressClickUntil = performance.now() + 500;
            resetGesture(false);
            // Programmatic activation reuses click navigation, page focus and More's dialog.
            if (enabled && shouldActivate && (target !== current || target.id === 'mobile-nav-more')) target.click();
            syncSelection();
        });
        document.addEventListener('pointercancel', event => {
            if (gesture?.pointerId === event.pointerId) cancelGesture();
        });
        nav.addEventListener('lostpointercapture', event => {
            // Touch starts with implicit capture on the pressed link; transferring it to
            // the nav emits a bubbling lost event from that link, not from this controller.
            if (event.target === nav && gesture?.pointerId === event.pointerId) cancelGesture();
        });
        nav.addEventListener('click', event => {
            // Suppress only a drag's synthesized click. Keyboard and programmatic clicks stay available.
            if (event.detail > 0 && performance.now() < suppressClickUntil) {
                event.preventDefault();
                event.stopImmediatePropagation();
            }
        }, true);
        nav.addEventListener('contextmenu', event => {
            if (enabled) event.preventDefault();
        });

        new MutationObserver(records => {
            if (records.some(record => items.includes(record.target))) syncSelection();
        }).observe(nav, { subtree: true, attributes: true, attributeFilter: ['class', 'aria-current', 'aria-expanded'] });
        new MutationObserver(syncAvailability).observe(root, { attributes: true, attributeFilter: ['data-ui-template'] });
        new ResizeObserver(syncAvailability).observe(nav);
        mobile.addEventListener('change', syncAvailability);
        window.addEventListener('resize', cancelGesture);
        window.visualViewport?.addEventListener('resize', cancelGesture);
        window.addEventListener('blur', cancelGesture);
        syncAvailability();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
})();
