const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const copyReader = path.join(__dirname, '..', 'static', 'js', 'ui-copy.js');

test('HTML-first copy reader exists before page scripts depend on it', () => {
    assert.equal(fs.existsSync(copyReader), true);
});

test('page templates expose copy roots and templates', () => {
    const expectedRoots = {
        'index.html': 'user-ui-copy',
        'admin.html': 'admin-ui-copy',
        'ad_detail.html': 'ad-ui-copy',
    };

    for (const [templateName, rootId] of Object.entries(expectedRoots)) {
        const source = fs.readFileSync(
            path.join(__dirname, '..', 'templates', templateName),
            'utf8',
        );
        assert.match(source, new RegExp(`id=["']${rootId}["']`));
        assert.match(source, /data-ui-copy=/);
        assert.match(source, /data-ui-template=/);
    }
});
