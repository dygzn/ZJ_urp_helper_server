const test = require('node:test');
const assert = require('node:assert/strict');

const {
    copyAdDetailValue,
    initializeAdDetailCopy,
} = require('../static/js/ad-detail.js');


function createButton(value, labelText) {
    const label = { textContent: labelText };
    return {
        dataset: { copyValue: value },
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
    const button = createButton('xttlqw_0329', '点击复制微信号');
    const feedback = { textContent: '' };
    const copiedValues = [];

    const copied = await copyAdDetailValue(
        button,
        feedback,
        async value => {
            copiedValues.push(value);
            return true;
        },
    );

    assert.equal(copied, true);
    assert.deepEqual(copiedValues, ['xttlqw_0329']);
    assert.equal(button.attributes['data-copy-state'], 'copied');
    assert.equal(button.label.textContent, '已复制');
    assert.equal(feedback.textContent, '已复制 xttlqw_0329');
});


test('复制备注失败时保留可操作提示', async () => {
    const button = createButton('meizhenxin', '点击复制备注');
    const feedback = { textContent: '' };

    const copied = await copyAdDetailValue(
        button,
        feedback,
        async () => false,
    );

    assert.equal(copied, false);
    assert.equal(button.attributes['data-copy-state'], 'failed');
    assert.equal(button.label.textContent, '复制失败，请手动复制');
    assert.equal(feedback.textContent, '复制失败，请手动复制 meizhenxin');
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

    assert.equal(
        initializeAdDetailCopy(documentObject, async value => {
            copiedValues.push(value);
            return true;
        }),
        true,
    );
    assert.equal(handlers.length, 2);

    await handlers[1]();
    assert.deepEqual(copiedValues, ['meizhenxin']);
    assert.equal(feedback.textContent, '已复制 meizhenxin');
});
