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

    async function copyAdDetailValue(button, feedback, copyTextFn) {
        const value = button?.dataset?.copyValue || '';
        let copied = false;

        try {
            copied = await resolveCopyText(copyTextFn)(value) === true;
        } catch (error) {
            copied = false;
        }

        const label = button?.querySelector?.('[data-copy-label]');
        button?.setAttribute?.('data-copy-state', copied ? 'copied' : 'failed');
        if (label) {
            label.textContent = copied ? '已复制' : '复制失败，请手动复制';
        }
        if (feedback) {
            feedback.textContent = copied
                ? `已复制 ${value}`
                : `复制失败，请手动复制 ${value}`;
        }
        return copied;
    }

    function initializeAdDetailCopy(documentObject, copyTextFn) {
        if (!documentObject || typeof documentObject.querySelector !== 'function') return false;

        const copyRoot = documentObject.querySelector('[data-ad-copy-root]');
        const feedback = documentObject.querySelector('[data-copy-feedback]');
        if (!copyRoot || typeof copyRoot.querySelectorAll !== 'function') return false;

        const buttons = copyRoot.querySelectorAll('[data-copy-value]');
        buttons.forEach(button => {
            if (typeof button.addEventListener !== 'function') return;
            button.addEventListener('click', function() {
                void copyAdDetailValue(button, feedback, copyTextFn);
            });
        });
        return buttons.length > 0;
    }

    if (typeof document !== 'undefined') {
        const initialize = () => initializeAdDetailCopy(document);
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initialize, { once: true });
        } else {
            initialize();
        }
    }

    return {
        copyAdDetailValue,
        initializeAdDetailCopy,
    };
}));
