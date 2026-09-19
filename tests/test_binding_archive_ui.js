const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

function setup(fetch) {
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, {disabled: false, checked: false, textContent: ''});
        return elements.get(id);
    };
    const context = vm.createContext({
        document: {addEventListener() {}, getElementById: element},
        crypto: webcrypto, Uint8Array, fetch, confirm: () => true,
    });
    vm.runInContext(fs.readFileSync('static/js/admin.js', 'utf8'), context);
    vm.runInContext('showAdminToast = () => {}; loadUsers = async () => {};', context);
    return {context, element};
}

const preview = {
    protocol_version: 2,
    target: {host: 'db.example', port: 3306, database: 'urp'}, enabled: true,
    fingerprint: 'test-fingerprint', unique_users: 1, archived_records: 0,
    counts: {users: 2, pending_requests: 0, wechat_bindings: 0, wechat_sessions: 0},
};
const response = data => ({ok: true, status: 200, json: async () => ({success: true, data})});

test('SQLite preview disables destructive button', async () => {
    const {context, element} = setup(async () => response({...preview, enabled: false}));
    await context.previewBindingArchive();
    assert.equal(element('archive-execute-button').disabled, true);
    assert.match(element('binding-archive-status').textContent, /SQLite/);
});

test('backup acknowledgement required before a POST', async () => {
    const requests = [];
    const {context} = setup(async (...args) => { requests.push(args); return response(preview); });
    await context.previewBindingArchive();
    await context.executeBindingArchive();
    assert.equal(requests.length, 1);
});

test('network retry reuses batch and success disables execution', async () => {
    const submitted = [];
    const {context, element} = setup(async (url, options) => {
        if (!options.method) return response(preview);
        submitted.push(JSON.parse(options.body));
        if (submitted.length === 1) throw new Error('network unavailable');
        return response({protocol_version: 2, batch_id: submitted[0].batch_id, counts: {users: 2}, account_count: 1});
    });
    await context.previewBindingArchive();
    assert.match(element('binding-archive-status').textContent, /db.example:3306\/urp/);
    element('binding-archive-prepared').checked = true;
    await context.executeBindingArchive();
    assert.equal(element('archive-execute-button').disabled, false);
    await context.executeBindingArchive();
    assert.equal(submitted.length, 2);
    assert.equal(submitted[0].batch_id, submitted[1].batch_id);
    assert.match(submitted[0].batch_id, /^[0-9a-f-]{36}$/);
    assert.equal(element('archive-execute-button').disabled, true);
    assert.match(element('binding-archive-status').textContent, /精简用户 1 个/);
});

test('legacy archives can be compacted even when there are no active bindings', async () => {
    const {context, element} = setup(async () => response({...preview,
        counts: {users: 0, pending_requests: 0, wechat_bindings: 0, wechat_sessions: 0,
            user_account_archive: 10, binding_record_archive: 3}}));
    await context.previewBindingArchive();
    assert.equal(element('archive-execute-button').disabled, false);
    assert.match(element('binding-archive-status').textContent, /旧版用户归档 10 条/);
    assert.match(element('binding-archive-status').textContent, /每个学号一条/);
});

test('legacy compact account rows enable compaction without active bindings', async () => {
    const {context, element} = setup(async () => response({...preview,
        counts: {users: 0, pending_requests: 0, wechat_bindings: 0, wechat_sessions: 0},
        legacy_compact_records: 40650,
    }));
    await context.previewBindingArchive();
    assert.equal(element('archive-execute-button').disabled, false);
    assert.match(element('binding-archive-status').textContent, /旧版复数表 40650 条/);
});

test('stale preview requires new preview before retry', async () => {
    const {context, element} = setup(async (url, options) => options.method
        ? {ok: false, status: 409, json: async () => ({success: false, message: '请重新预览'})}
        : response(preview));
    await context.previewBindingArchive();
    element('binding-archive-prepared').checked = true;
    await context.executeBindingArchive();
    assert.equal(element('archive-execute-button').disabled, true);
    assert.equal(element('archive-preview-button').disabled, false);
});

test('old service preview disables execution', async () => {
    const {context, element} = setup(async () => response({...preview, protocol_version: undefined}));
    await context.previewBindingArchive();
    assert.equal(element('archive-execute-button').disabled, true);
    assert.match(element('binding-archive-status').textContent, /版本/);
});

test('legacy success payload never renders undefined or claims compact success', async () => {
    const {context, element} = setup(async (url, options) => options.method
        ? response({batch_id: 'old-batch', counts: {users: 8130}})
        : response(preview));
    await context.previewBindingArchive();
    element('binding-archive-prepared').checked = true;
    await context.executeBindingArchive();
    const status = element('binding-archive-status').textContent;
    assert.doesNotMatch(status, /undefined/);
    assert.match(status, /未确认/);
    assert.match(status, /old-batch/);
    assert.equal(element('archive-execute-button').disabled, true);
});
