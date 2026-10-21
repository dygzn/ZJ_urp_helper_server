const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The old branch did not migrate page copy; importing its optional reader must
// preserve existing DOM and work without installing a new global page lifecycle.
test('copy reader can load without a DOM and returns safe empty results', () => {
    const context = vm.createContext({});
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/js/ui-copy.js'), 'utf8'), context);
    assert.equal(context.URPCopy.get('missing'), '');
    assert.equal(context.URPCopy.format('missing', { value: '<script>' }), '');
    assert.equal(context.URPCopy.clone('missing'), null);
});

test('loading copy reader does not query or mutate the current page', () => {
    let reads = 0;
    const document = { querySelectorAll() { reads++; return []; } };
    const context = vm.createContext({ document });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/js/ui-copy.js'), 'utf8'), context);
    assert.equal(reads, 0);
    assert.equal(context.URPCopy.get('missing'), '');
    assert.equal(reads, 1);
});
