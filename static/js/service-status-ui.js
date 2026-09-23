(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.ServiceStatusUI = api;
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    function formatUpdatedAt(value) {
        if (!value) {
            return '尚未更新';
        }

        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) {
            return `更新于 ${value}`;
        }

        return `更新于 ${parsed.toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        })}`;
    }

    function buildServiceStatusViewModel(data) {
        const source = data && typeof data === 'object' ? data : {};
        const statusText = typeof source.status_text === 'string' && source.status_text.trim()
            ? source.status_text.trim()
            : '暂未设置状态';
        const acceptingOrders = source.accepting_orders === true;

        return {
            statusText,
            acceptingOrders,
            availabilityText: acceptingOrders ? '当前可接单' : '暂不接单',
            updatedText: formatUpdatedAt(source.updated_at),
        };
    }

    async function copyText(text, environment) {
        const value = typeof text === 'string' ? text : '';
        if (!value) return false;

        const scope = environment && typeof environment === 'object' ? environment : {};
        const navigatorObject = Object.prototype.hasOwnProperty.call(scope, 'navigator')
            ? scope.navigator
            : (typeof navigator !== 'undefined' ? navigator : null);
        const documentObject = Object.prototype.hasOwnProperty.call(scope, 'document')
            ? scope.document
            : (typeof document !== 'undefined' ? document : null);

        if (navigatorObject?.clipboard?.writeText) {
            try {
                await navigatorObject.clipboard.writeText(value);
                return true;
            } catch (error) {
                // Clipboard API 失败时继续使用兼容复制方案。
            }
        }

        if (!documentObject?.body
            || typeof documentObject.createElement !== 'function'
            || typeof documentObject.execCommand !== 'function') {
            return false;
        }

        const textarea = documentObject.createElement('textarea');
        textarea.value = value;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';

        try {
            documentObject.body.appendChild(textarea);
            textarea.select();
            textarea.setSelectionRange(0, value.length);
            return documentObject.execCommand('copy') === true;
        } catch (error) {
            return false;
        } finally {
            try {
                documentObject.body.removeChild(textarea);
            } catch (error) {
                // 元素没有成功挂载时无需继续清理。
            }
        }
    }

    function nextContactPopoverState(isOpen, action) {
        if (action === 'toggle') return !isOpen;
        if (action === 'outside-click' || action === 'escape' || action === 'select') {
            return false;
        }
        return isOpen === true;
    }

    return {
        buildServiceStatusViewModel,
        copyText,
        formatUpdatedAt,
        nextContactPopoverState,
    };
}));
