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

    return {
        buildServiceStatusViewModel,
        formatUpdatedAt,
    };
}));
