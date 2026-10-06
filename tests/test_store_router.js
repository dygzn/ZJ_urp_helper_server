const test = require('node:test');
const assert = require('node:assert/strict');

test('store shares user and week updates and allows subscribers to detach', async () => {
    const { state, store } = await import('../static/js/modules/store.js');
    const seen = [];
    const detach = store.subscribe((value, key) => seen.push([key, value[key]]));
    store.setState({ currentWeek: 7, user: { username: 'student' } });
    assert.equal(state.currentUsername, 'student');
    assert.equal(store.getState().currentWeek, 7);
    detach();
    state.currentWeek = 8;
    assert.equal(seen.length, 2);
    state.currentUsername = null;
    assert.equal(state.user, null);
});

test('router destroys the old page before mounting the next and forwards all params', async () => {
    const { state } = await import('../static/js/modules/store.js');
    const { registerPage, switchPage, unmountCurrentPage } = await import('../static/js/modules/router.js');
    const { pageResources } = await import('../static/js/modules/lifecycle.js');
    const order = [];
    const classes = () => ({ add() {}, remove() {} });
    const pages = ['home', 'grades'].map(name => ({ id: `page-${name}`, classList: classes() }));
    const title = { textContent: '' };
    global.document = {
        getElementById: id => pages.find(page => page.id === id) || (id === 'page-title' ? title : null),
        querySelectorAll: selector => selector === '.page' ? pages : [],
    };
    global.localStorage = { setItem() {} };
    state.currentPage = null;
    registerPage('home', {
        mount(container) { order.push(['mount home', container.id]); },
        unmount() { order.push(['unmount home']); },
    });
    registerPage('grades', {
        mount(container, params) { order.push(['mount grades', container.id, params.filter]); },
        unmount() { order.push(['unmount grades']); },
    });
    switchPage('home');
    const oldScope = pageResources('home').capture();
    switchPage('grades', { filter: 'failed' });
    assert.equal(oldScope.signal.aborted, true);
    assert.deepEqual(order, [['mount home', 'page-home'], ['unmount home'],
        ['mount grades', 'page-grades', 'failed']]);
    const previous = pageResources('grades').capture();
    switchPage('grades', { filter: 'current' });
    assert.equal(previous.isActive(), false);
    assert.equal(pageResources('grades').capture().isActive(), true);
    assert.equal(state.currentPage, 'grades');
    unmountCurrentPage();
    assert.equal(state.currentPage, null);
    delete global.document;
    delete global.localStorage;
});
