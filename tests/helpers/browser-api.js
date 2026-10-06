const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

// Load the production client; only the browser and HTTP boundaries are adapted.
function installApi(context) {
    Object.assign(context, { Headers, AbortController, DOMException, crypto: webcrypto,
        setTimeout: context.setTimeout || setTimeout, clearTimeout: context.clearTimeout || clearTimeout });
    context.CustomEvent = class extends Event {
        constructor(type, options) { super(type); this.detail = options.detail; }
    };
    const events = new EventTarget();
    const originalAdd = context.document.addEventListener.bind(context.document);
    context.document.addEventListener = (type, listener, options) => {
        events.addEventListener(type, listener, options);
        originalAdd(type, listener, options);
    };
    context.document.dispatchEvent = event => events.dispatchEvent(event);
    let fetchImpl = context.fetch;
    Object.defineProperty(context, 'fetch', {
        configurable: true,
        get: () => async (...args) => {
            const response = await fetchImpl(...args);
            if (response instanceof Response) return response;
            return new Response(JSON.stringify(await response.json()), {
                status: response.status || (response.ok === false ? 500 : 200),
                headers: { 'Content-Type': 'application/json' },
            });
        },
        set: value => { fetchImpl = value; },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../static/js/api.js'), 'utf8'), context);
    return context.apiClient;
}

module.exports = { installApi };
