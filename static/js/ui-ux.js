(function attachUrpUi(root, factory) {
    const api = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }

    if (root) {
        root.URPUI = api;
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function createUrpUi() {
    const guestAccessCopy = {
        schedule: {
            title: '日程查询需要登录教务账号',
            description: '登录后即可查看课程和考试安排，并保留当前页面操作。',
            button: '立即登录',
        },
        exams: {
            title: '考试查询需要登录教务账号',
            description: '登录后即可查看考试安排，并保留当前页面操作。',
            button: '立即登录',
        },
        grades: {
            title: '成绩查询需要登录教务账号',
            description: '登录后即可查询成绩，并保留当前页面操作。',
            button: '立即登录',
        },
        evaluation: {
            title: '评教需要登录教务账号',
            description: '登录后即可进入评教页面，并保留当前页面操作。',
            button: '立即登录',
        },
        'shortcut-api': {
            title: '快捷 API 需要登录教务账号',
            description: '登录后即可使用快捷 API，并保留当前页面操作。',
            button: '立即登录',
        },
    };

    function normalizePageName(value, availablePages, fallback = 'home') {
        const pages = Array.isArray(availablePages)
            ? availablePages
            : Array.from(availablePages || []);
        const validFallback = pages.includes(fallback)
            ? fallback
            : (pages.includes('home') ? 'home' : pages[0]);

        return pages.includes(value) ? value : (validFallback || 'home');
    }

    function getGuestAccessCopy(pageName) {
        return guestAccessCopy[pageName] || {
            title: '登录教务账号后继续',
            description: '请先登录教务账号，再使用此功能。',
            button: '立即登录',
        };
    }

    function isModalDismissible(modal) {
        if (!modal) return true;
        if (modal.id === 'login-modal') return false;

        const datasetValue = modal.dataset && modal.dataset.dismissible;
        return datasetValue !== 'false';
    }

    function getFocusableElements(container) {
        if (!container || typeof container.querySelectorAll !== 'function') {
            return [];
        }

        return Array.from(container.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        )).filter((element) => {
            if (!element || element.disabled || element.hidden) return false;

            const ariaHidden = typeof element.getAttribute === 'function'
                ? element.getAttribute('aria-hidden')
                : element['aria-hidden'];
            if (ariaHidden === 'true') return false;

            if (typeof element.getClientRects === 'function') {
                return element.getClientRects().length > 0;
            }

            return true;
        });
    }

    function syncTabAriaState(tabButtons, panels, selectedName) {
        const tabs = Array.from(tabButtons || []);
        const tabPanels = Array.from(panels || []);
        const getTabName = tab => {
            if (tab?.dataset?.tab) return tab.dataset.tab;
            const dataTab = tab?.getAttribute?.('data-tab');
            if (dataTab) return dataTab;
            return String(tab?.id || '').replace(/-button$/, '').replace(/^tab-/, '');
        };
        const getPanelName = panel => String(panel?.dataset?.tabPanel || panel?.id || '')
            .replace(/^tab-/, '');

        tabs.forEach(tab => {
            const name = getTabName(tab);
            const selected = name === selectedName;
            tab.classList?.toggle?.('active', selected);
            tab.setAttribute?.('aria-selected', String(selected));
            tab.setAttribute?.('aria-controls', `tab-${name}`);
            tab.setAttribute?.('tabindex', selected ? '0' : '-1');
        });

        tabPanels.forEach(panel => {
            const name = getPanelName(panel);
            const selected = name === selectedName;
            panel.classList?.toggle?.('active', selected);
            panel.setAttribute?.('role', 'tabpanel');
            panel.setAttribute?.('aria-labelledby', `tab-${name}-button`);
            panel.hidden = !selected;
        });
    }

    return {
        normalizePageName,
        getGuestAccessCopy,
        isModalDismissible,
        getFocusableElements,
        syncTabAriaState,
    };
}));
