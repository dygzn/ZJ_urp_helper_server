/* 页面模板只改变外观。浏览器 Web 版液态玻璃是视觉近似，并非 Apple 原生材质。 */
(function () {
    'use strict';

    const storageKey = 'urp_ui_template';
    const choices = ['workspace', 'glass'];
    const root = document.documentElement;
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    const canvasColor = themeMeta?.content || '#f3f6fa';

    function readChoice() {
        try {
            const value = localStorage.getItem(storageKey);
            return choices.includes(value) ? value : 'workspace';
        } catch (_) {
            return 'workspace';
        }
    }

    function applyChoice(value, persist) {
        const choice = choices.includes(value) ? value : 'workspace';
        root.dataset.uiTemplate = choice;
        if (themeMeta) themeMeta.content = choice === 'glass'
            ? '#e9e7e2' : canvasColor;
        if (persist) {
            try { localStorage.setItem(storageKey, choice); } catch (_) { /* 浏览器禁止存储时仍可临时切换 */ }
        }
        document.querySelectorAll('input[name="ui-template"]').forEach(input => {
            input.checked = input.value === choice;
        });
    }

    applyChoice(readChoice(), false);

    function createTrigger(container, className) {
        if (!container) return null;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `appearance-trigger ${className}`;
        button.textContent = '外观';
        button.setAttribute('aria-haspopup', 'dialog');
        button.setAttribute('aria-controls', 'appearance-dialog');
        container.prepend(button);
        return button;
    }

    function initPicker() {
        const app = document.body.classList.contains('urp-app');
        const admin = document.body.classList.contains('urp-admin');
        if (!app && !admin) return;

        const triggers = app
            ? [createTrigger(document.querySelector('.header'), 'appearance-trigger-header'),
               createTrigger(document.querySelector('.sidebar-footer'), 'appearance-trigger-sidebar')]
            : [createTrigger(document.querySelector('.admin-header-actions'), 'appearance-trigger-admin')];

        const dialog = document.createElement('dialog');
        dialog.id = 'appearance-dialog';
        dialog.className = 'appearance-dialog';
        dialog.setAttribute('aria-labelledby', 'appearance-title');
        dialog.setAttribute('aria-describedby', 'appearance-description');
        dialog.innerHTML = `
            <div class="appearance-dialog-head">
                <div><h2 id="appearance-title">页面外观</h2><p id="appearance-description">即时切换，选择保存在当前浏览器</p></div>
                <button class="appearance-close" type="button" aria-label="关闭页面外观">关闭</button>
            </div>
            <div class="appearance-options" role="radiogroup" aria-label="页面模板">
                <label class="appearance-option">
                    <input type="radio" name="ui-template" value="workspace">
                    <span class="appearance-preview appearance-preview-workspace" aria-hidden="true"><i></i><b></b><b></b></span>
                    <span class="appearance-option-copy"><strong>清晰工作台</strong><small>浅蓝灰底色 · 白色内容面 · 清楚的蓝色操作</small></span>
                </label>
                <label class="appearance-option">
                    <input type="radio" name="ui-template" value="glass">
                    <span class="appearance-preview appearance-preview-glass" aria-hidden="true"><i></i><b></b><b></b></span>
                    <span class="appearance-option-copy"><strong>液态玻璃</strong><small>无色水晶 · 珍珠白与银灰 · 通透面板与流动高光</small></span>
                </label>
            </div>`;
        document.body.append(dialog);

        let returnFocus = null;
        function closePicker() {
            dialog.close();
        }
        triggers.filter(Boolean).forEach(button => button.addEventListener('click', () => {
            returnFocus = button;
            applyChoice(root.dataset.uiTemplate, false);
            dialog.showModal();
            document.body.classList.add('appearance-open');
            dialog.querySelector('input:checked')?.focus();
        }));
        dialog.querySelector('.appearance-close').addEventListener('click', closePicker);
        dialog.addEventListener('click', event => {
            if (event.target !== dialog) return;
            const bounds = dialog.getBoundingClientRect();
            if (event.clientX < bounds.left || event.clientX > bounds.right
                || event.clientY < bounds.top || event.clientY > bounds.bottom) closePicker();
        });
        dialog.addEventListener('change', event => {
            if (event.target?.name !== 'ui-template') return;
            applyChoice(event.target.value, true);
        });
        // 原生 dialog 隔离背景；补上 Tab 循环，并避免下层导航收到同一次按键。
        dialog.addEventListener('keydown', event => {
            event.stopPropagation();
            if (event.key !== 'Tab') return;
            const focusable = Array.from(dialog.querySelectorAll('button, input:checked'));
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        });
        dialog.addEventListener('close', () => {
            document.body.classList.remove('appearance-open');
            if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
            returnFocus = null;
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initPicker);
    else initPicker();
    window.addEventListener('storage', event => {
        if (event.key === storageKey) applyChoice(readChoice(), false);
    });
})();
