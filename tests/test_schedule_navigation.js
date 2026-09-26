const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('another class schedule puts return before its title and returns to my schedule', async () => {
    const classes = new Set();
    const message = {
        style: {}, children: [], textContent: '',
        classList: {
            add(value) { classes.add(value); },
            remove(value) { classes.delete(value); },
        },
        replaceChildren(...children) { this.children = children; },
    };
    const document = {
        addEventListener() {},
        getElementById(id) { return id === 'schedule-message' ? message : null; },
        createElement() {
            return {
                listeners: {},
                addEventListener(type, listener) { this.listeners[type] = listener; },
            };
        },
    };
    const localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
    const context = vm.createContext({
        document, localStorage, window: {}, console, TextEncoder,
        fetch: async () => ({ json: async () => ({ success: true, data: { schedule: { '1': [] } } }) }),
    });
    const source = fs.readFileSync(path.join(__dirname, '../static/js/main.js'), 'utf8');
    vm.runInContext(source, context);
    vm.runInContext(`
        omSelected = { grade: '2024', major: '机械', class_num: '1' };
        getDeviceId = () => 'device';
        displaySchedule = () => {};
        refreshScheduleDisplay = () => {};
    `, context);

    await vm.runInContext('loadOtherMajorSchedule()', context);

    assert.equal(classes.has('schedule-message-detail'), true);
    assert.equal(message.children[0].textContent, '← 返回我的课表');
    assert.equal(message.children[1].textContent, '2024级 专业机械 1班（仅课程名与时间）');

    message.children[0].listeners.click();
    assert.equal(classes.has('schedule-message-detail'), false);
    assert.equal(message.style.display, 'none');
    assert.equal(vm.runInContext('otherMajorScheduleData', context), null);
});
