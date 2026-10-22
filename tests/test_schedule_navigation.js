const { readAppSource } = require('./helpers/app-source');
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
    const source = readAppSource();
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

test('mobile schedule keeps the update action in the menu', () => {
    let externalUpdates = 0;
    const controls = { querySelector:()=>null, append(){} };
    const week = { querySelector:()=>controls };
    const toolbar = { prepend(){} };
    const container = { querySelector:s=>s==='.schedule-toolbar'?toolbar:week, prepend(){} };
    const nodes = { 'schedule-mobile-gesture':{append(){}},
        'schedule-mobile-actions':{prepend(){externalUpdates++}}, 'update-schedule-btn':{} };
    const document = { addEventListener(){}, getElementById:id=>nodes[id]||null,
        querySelector:s=>s==='#page-schedule .schedule-container'?container:null };
    const context = vm.createContext({document,window:{},console,TextEncoder,localStorage:{getItem(){return null}}});
    vm.runInContext(readAppSource(),context);
    context.createMobileScheduleLayout()(true);
    assert.equal(externalUpdates,0);
});

test('desktop schedule puts every action including update in the more menu', () => {
    const update={id:'update-schedule-btn'}, add={id:'schedule-add-course'}, moved=[];
    const nav={querySelectorAll:()=>[]};
    const menu={querySelector:()=>({append:button=>moved.push(button)})};
    const nodes={sidebar:{querySelector:()=>nav},'desktop-navigation':{append(){}},'desktop-nav-more':menu,'schedule-more':menu};
    const document={addEventListener(){},getElementById:id=>nodes[id]||null,
        querySelector:()=>({querySelectorAll:()=>[update,add],insertBefore(){throw Error('unexpected exposed action')}})};
    const context=vm.createContext({document,window:{},console,TextEncoder,localStorage:{getItem(){return null}}});
    vm.runInContext(readAppSource(),context);
    context.createDesktopWorkspaceLayout({listen(){}})(true);
    assert.deepEqual(moved,[update,add]);
});
