const test = require('node:test');
const assert = require('node:assert/strict');

const URPCopy = require('../static/js/ui-copy.js');

class FakeNode {
    constructor({ copyKey = null, templateKey = null, text = '', children = [] } = {}) {
        this.dataset = {};
        if (copyKey !== null) this.dataset.uiCopy = copyKey;
        if (templateKey !== null) this.dataset.uiTemplate = templateKey;
        this._textContent = text;
        this.children = children;
        this.content = null;
        this.replacedChildren = [];
    }

    get textContent() {
        if (this.children.length) {
            return this.children.map(child => child.textContent).join('');
        }
        return this._textContent;
    }

    set textContent(value) {
        this._textContent = String(value);
        this.children = [];
    }

    appendChild(child) {
        this.children.push(child);
        return child;
    }

    replaceChildren(...children) {
        this.replacedChildren = children;
        this.children = children;
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }

    querySelectorAll(selector) {
        const matches = [];
        const matchesSelf =
            (selector === '[data-ui-copy]' && this.dataset.uiCopy !== undefined) ||
            (selector === '[data-ui-template]' && this.dataset.uiTemplate !== undefined) ||
            (selector === '[data-ui-slot]' && this.dataset.uiSlot !== undefined);
        if (matchesSelf) matches.push(this);
        for (const child of this.children) {
            matches.push(...child.querySelectorAll(selector));
        }
        return matches;
    }

    cloneNode(deep = false) {
        const clone = new FakeNode({
            copyKey: this.dataset.uiCopy ?? null,
            templateKey: this.dataset.uiTemplate ?? null,
            text: this._textContent,
        });
        clone.dataset.uiSlot = this.dataset.uiSlot;
        if (deep) clone.children = this.children.map(child => child.cloneNode(true));
        if (this.content) clone.content = this.content.cloneNode(true);
        return clone;
    }
}

function makeRoot() {
    const root = new FakeNode();
    root.appendChild(new FakeNode({ copyKey: 'greeting', text: '你好，{{name}}' }));
    root.appendChild(new FakeNode({ copyKey: 'plain', text: '静态 HTML 文案' }));

    const messageSlot = new FakeNode();
    messageSlot.dataset.uiSlot = 'message';
    const template = new FakeNode({ templateKey: 'state' });
    template.content = new FakeNode({ children: [messageSlot] });
    root.appendChild(template);
    return root;
}

test('从 HTML copy 节点读取并格式化固定文案', () => {
    const root = makeRoot();

    assert.equal(URPCopy.get('plain', root), '静态 HTML 文案');
    assert.equal(URPCopy.format('greeting', { name: 'Ada' }, root), '你好，Ada');
    assert.equal(URPCopy.format('missing', { name: 'Ada' }, root), '');
    assert.equal(URPCopy.format('greeting', {}, root), '你好，');
});

test('template slot 以纯文本挂载，不能把值解释为 HTML', () => {
    const root = makeRoot();
    const container = new FakeNode();

    URPCopy.mount(container, 'state', {
        message: '<img src=x onerror=alert(1)>',
    }, root);

    const slot = container.querySelector('[data-ui-slot]');
    assert.ok(slot);
    assert.equal(slot.textContent, '<img src=x onerror=alert(1)>');
    assert.equal(slot.children.length, 0);
});

test('特殊 copy key 不会被拼接进选择器', () => {
    const root = new FakeNode();
    root.appendChild(new FakeNode({ copyKey: 'key[0]."quoted"', text: '可读取' }));

    assert.equal(URPCopy.get('key[0]."quoted"', root), '可读取');
});
