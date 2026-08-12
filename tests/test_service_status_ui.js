const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildServiceStatusViewModel,
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
