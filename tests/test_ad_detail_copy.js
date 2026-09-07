const test = require('node:test');
const assert = require('node:assert/strict');

const {
    copyAdDetailValue,
    cleanAdDetailSource,
    initializeAdDetailCopy,
    initializeStickyContactAction,
} = require('../static/js/ad-detail.js');


function createButton(value, labelText, successMessage = '') {
    const label = { textContent: labelText };
    return {
        dataset: { copyValue: value, copySuccess: successMessage },
        attributes: {},
        querySelector(selector) {
            return selector === '[data-copy-label]' ? label : null;
        },
        setAttribute(name, valueToSet) {
            this.attributes[name] = valueToSet;
        },
        get label() {
            return label;
        },
    };
}


test('复制商家微信成功后更新按钮状态和反馈', async () => {
    const button = createButton(
        'xttlqw_0329',
        '复制微信，立即咨询',
        '微信号已复制，请打开微信搜索添加',
    );
    const feedback = { textContent: '' };
    const copiedValues = [];
    const trackedEvents = [];

    const result = await copyAdDetailValue(
        button,
        feedback,
        async value => {
            copiedValues.push(value);
            return true;
        },
        eventName => trackedEvents.push(eventName),
    );

    assert.deepEqual(result, {
        copied: true,
        value: 'xttlqw_0329',
        message: '微信号已复制，请打开微信搜索添加',
    });
    assert.deepEqual(copiedValues, ['xttlqw_0329']);
    assert.deepEqual(trackedEvents, ['copy']);
    assert.equal(button.attributes['data-copy-state'], 'copied');
    assert.equal(button.label.textContent, '已复制，打开微信搜索添加');
    assert.equal(feedback.textContent, '微信号已复制，请打开微信搜索添加');
});


test('复制备注失败时保留可操作提示', async () => {
    const button = createButton('meizhenxin', '点击复制备注');
    const feedback = { textContent: '' };

    const result = await copyAdDetailValue(
        button,
        feedback,
        async () => false,
    );

    assert.deepEqual(result, {
        copied: false,
        value: 'meizhenxin',
        message: '复制失败，请长按复制',
    });
    assert.equal(button.attributes['data-copy-state'], 'failed');
    assert.equal(button.label.textContent, '复制失败，请长按复制');
    assert.equal(feedback.textContent, '复制失败，请长按复制');
});


test('详情页初始化为两个复制按钮绑定点击事件', async () => {
    const buttons = [
        createButton('xttlqw_0329', '点击复制微信号'),
        createButton('meizhenxin', '点击复制备注'),
    ];
    const feedback = { textContent: '' };
    const handlers = [];
    buttons.forEach(button => {
        button.addEventListener = (eventName, handler) => {
            assert.equal(eventName, 'click');
            handlers.push(handler);
        };
    });

    const documentObject = {
        querySelector(selector) {
            if (selector === '[data-ad-copy-root]') return this.root;
            if (selector === '[data-copy-feedback]') return feedback;
            return null;
        },
        root: {
            querySelectorAll(selector) {
                assert.equal(selector, '[data-copy-value]');
                return buttons;
            },
        },
    };
    const copiedValues = [];
    const trackedEvents = [];

    assert.equal(
        initializeAdDetailCopy(documentObject, async value => {
            copiedValues.push(value);
            return true;
        }, eventName => trackedEvents.push(eventName)),
        true,
    );
    assert.equal(handlers.length, 2);

    await handlers[1]();
    assert.deepEqual(copiedValues, ['meizhenxin']);
    assert.deepEqual(trackedEvents, ['copy']);
    assert.equal(feedback.textContent, '已复制 meizhenxin');
});


test('首屏复制按钮离开视口后才显示手机固定入口', () => {
    const heroButton = {};
    const stickyButton = { hidden: false };
    let observedTarget = null;
    let observerCallback = null;
    const documentObject = {
        querySelector(selector) {
            if (selector === '.ad-detail-hero-copy') return heroButton;
            if (selector === '.ad-detail-sticky-cta') return stickyButton;
            return null;
        },
    };
    const observerFactory = callback => {
        observerCallback = callback;
        return {
            observe(target) {
                observedTarget = target;
            },
        };
    };

    assert.equal(
        initializeStickyContactAction(documentObject, observerFactory),
        true,
    );
    assert.equal(stickyButton.hidden, true);
    assert.equal(observedTarget, heroButton);

    observerCallback([{ target: heroButton, isIntersecting: false }]);
    assert.equal(stickyButton.hidden, false);

    observerCallback([{ target: heroButton, isIntersecting: true }]);
    assert.equal(stickyButton.hidden, true);
});


test('首次进入详情页后移除来源参数避免刷新重复计数', () => {
    let replacedUrl = '';
    const windowObject = {
        location: {
            href: 'https://example.test/ad-detail?source=header&campaign=student#rules',
        },
        history: {
            state: { from: 'header' },
            replaceState(_state, _title, url) {
                replacedUrl = url;
            },
        },
    };

    assert.equal(cleanAdDetailSource(windowObject), true);
    assert.equal(replacedUrl, '/ad-detail?campaign=student#rules');
});


test('复制成功后把本地保存的学号直接随事件提交', async () => {
    const originalFetch = globalThis.fetch;
    const originalLocalStorage = globalThis.localStorage;
    const requests = [];
    globalThis.localStorage = {
        getItem(key) {
            return key === 'urp_bound_username' ? '2023123456' : null;
        },
    };
    globalThis.fetch = async (url, options) => {
        requests.push({ url, options });
        return { ok: true };
    };

    try {
        const result = await copyAdDetailValue(
            createButton('xttlqw_0329', '复制微信，先聊两句'),
            { textContent: '' },
            async () => true,
        );

        assert.deepEqual(result, {
            copied: true,
            value: 'xttlqw_0329',
            message: '已复制 xttlqw_0329',
        });
        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, '/api/ad/event');
        assert.deepEqual(
            JSON.parse(requests[0].options.body),
            { event: 'copy', username: '2023123456' },
        );
    } finally {
        globalThis.fetch = originalFetch;
        if (originalLocalStorage === undefined) {
            delete globalThis.localStorage;
        } else {
            globalThis.localStorage = originalLocalStorage;
        }
    }
});
