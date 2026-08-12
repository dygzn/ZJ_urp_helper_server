const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildServiceStatusViewModel,
    copyText,
} = require('../static/js/service-status-ui.js');


test('未设置状态形成不可接单展示模型', () => {
    assert.deepEqual(buildServiceStatusViewModel({}), {
        statusText: '暂未设置状态',
        acceptingOrders: false,
        availabilityText: '暂不接单',
        updatedText: '尚未更新',
    });
});


test('已设置状态保留文字并形成可接单展示模型', () => {
    const view = buildServiceStatusViewModel({
        status_text: '上课',
        accepting_orders: true,
        updated_at: '2026-08-13T12:00:00',
    });

    assert.equal(view.statusText, '上课');
    assert.equal(view.acceptingOrders, true);
    assert.equal(view.availabilityText, '当前可接单');
    assert.notEqual(view.updatedText, '尚未更新');
});


test('优先使用 Clipboard API 复制联系账号', async () => {
    const writes = [];
    const copied = await copyText('786171937', {
        navigator: {
            clipboard: {
                writeText: async value => writes.push(value),
            },
        },
        document: null,
    });

    assert.equal(copied, true);
    assert.deepEqual(writes, ['786171937']);
});


test('Clipboard API 失败时使用 textarea 兼容复制', async () => {
    const lifecycle = [];
    const textarea = {
        value: '',
        style: {},
        setAttribute() {},
        select() { lifecycle.push('select'); },
        setSelectionRange() {},
    };
    const document = {
        createElement(tagName) {
            assert.equal(tagName, 'textarea');
            return textarea;
        },
        body: {
            appendChild(node) { lifecycle.push(['append', node.value]); },
            removeChild() { lifecycle.push('remove'); },
        },
        execCommand(command) {
            lifecycle.push(command);
            return true;
        },
    };

    const copied = await copyText('Dygzn123', {
        navigator: {
            clipboard: {
                writeText: async () => { throw new Error('blocked'); },
            },
        },
        document,
    });

    assert.equal(copied, true);
    assert.deepEqual(lifecycle, [
        ['append', 'Dygzn123'],
        'select',
        'copy',
        'remove',
    ]);
});


test('没有可用复制能力时返回失败', async () => {
    assert.equal(
        await copyText('Dygzn123', { navigator: null, document: null }),
        false,
    );
});
