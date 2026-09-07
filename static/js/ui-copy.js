(function attachUiCopy(global, factory) {
    const api = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (global) {
        global.URPCopy = api;
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function createUiCopy() {
    const selectors = {
        uiCopy: '[data-ui-copy]',
        uiTemplate: '[data-ui-template]',
    };

    function resolveRoot(root) {
        if (root) return root;
        if (typeof document !== 'undefined') return document;
        return null;
    }

    function getDataValue(node, name) {
        if (!node) return undefined;
        if (node.dataset && node.dataset[name] !== undefined) {
            return node.dataset[name];
        }
        if (typeof node.getAttribute === 'function') {
            return node.getAttribute(`data-${name.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`)}`);
        }
        return undefined;
    }

    function findNode(key, dataName, root) {
        const resolvedRoot = resolveRoot(root);
        if (!resolvedRoot || key === undefined || key === null) return null;

        if (getDataValue(resolvedRoot, dataName) === String(key)) {
            return resolvedRoot;
        }
        if (typeof resolvedRoot.querySelectorAll !== 'function') return null;

        const candidates = resolvedRoot.querySelectorAll(selectors[dataName]);
        for (const candidate of candidates) {
            if (getDataValue(candidate, dataName) === String(key)) {
                return candidate;
            }
        }
        return null;
    }

    function get(key, root) {
        const node = findNode(key, 'uiCopy', root);
        return node && node.textContent ? node.textContent : '';
    }

    function format(key, values, root) {
        const source = get(key, root);
        const safeValues = values || {};
        return source.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (match, token) => {
            if (!Object.prototype.hasOwnProperty.call(safeValues, token)) return '';
            const value = safeValues[token];
            return value === undefined || value === null ? '' : String(value);
        });
    }

    function clone(key, root) {
        const template = findNode(key, 'uiTemplate', root);
        if (!template || !template.content || typeof template.content.cloneNode !== 'function') {
            return null;
        }
        return template.content.cloneNode(true);
    }

    function mount(container, key, values, root) {
        if (!container || typeof container.replaceChildren !== 'function') return null;

        const fragment = clone(key, root);
        if (!fragment) {
            container.replaceChildren();
            return null;
        }

        if (typeof fragment.querySelectorAll === 'function') {
            const slots = fragment.querySelectorAll('[data-ui-slot]');
            slots.forEach(slot => {
                const slotName = getDataValue(slot, 'uiSlot');
                const value = values && slotName !== undefined
                    ? values[slotName]
                    : '';
                slot.textContent = value === undefined || value === null ? '' : String(value);
            });
        }
        container.replaceChildren(fragment);
        return fragment;
    }

    return Object.freeze({ get, format, clone, mount });
}));
