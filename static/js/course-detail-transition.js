(function(root) {
    'use strict';

    function createCourseDetailTransition({ window, document }) {
        const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
        const easing = 'cubic-bezier(0.2, 0.7, 0.2, 1)';
        let current = null;

        function stop(state) {
            // 先失效本轮回调，再取消；取消的 finished Promise 不得清理下一轮动画。
            state.run = null;
            state.animations.splice(0).forEach(animation => animation.cancel());
            if (state.label) state.label.remove();
            if (state.mark) state.mark.remove();
            state.label = null;
            state.mark = null;
            state.modal.classList.remove('is-course-morphing');
        }

        function reset(modal) {
            if (!current || (modal && current.modal !== modal)) return;
            stop(current);
            current.source.classList.remove('is-detail-source');
            current = null;
        }

        function visible(rect) {
            return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0
                && rect.left < window.innerWidth && rect.top < window.innerHeight;
        }

        function transformBetween(source, destination) {
            return `translate(${source.left - destination.left}px, ${source.top - destination.top}px) scale(${source.width / destination.width}, ${source.height / destination.height})`;
        }

        function sourceRadius(style, source, destination) {
            const radius = Number.parseFloat(style.borderRadius) || 0;
            return `${radius * destination.width / source.width}px / ${radius * destination.height / source.height}px`;
        }

        function textStyle(element) {
            const style = window.getComputedStyle(element);
            return { fontSize: style.fontSize, lineHeight: style.lineHeight, fontWeight: style.fontWeight, color: style.color };
        }

        function markRect(element) {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            const mark = window.getComputedStyle(element, '::before');
            return { left: rect.left + (Number.parseFloat(style.borderLeftWidth) || 0) + (Number.parseFloat(mark.left) || 0),
                top: rect.top + (Number.parseFloat(style.borderTopWidth) || 0) + (Number.parseFloat(mark.top) || 0),
                width: Number.parseFloat(mark.width) || 5,
                height: Number.parseFloat(mark.height) || Math.max(1, rect.height - 16) };
        }

        function sharedMark(state, from, to, duration) {
            const mark = document.createElement('span');
            mark.className = 'course-detail-shared-mark';
            mark.setAttribute('aria-hidden', 'true');
            Object.assign(mark.style, { left: `${from.left}px`, top: `${from.top}px`,
                width: `${from.width}px`, height: `${from.height}px` });
            state.modal.appendChild(mark);
            state.mark = mark;
            state.animations.push(mark.animate([
                { transform: 'translate(0, 0)' },
                { transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / Math.max(1, from.width)}, ${to.height / Math.max(1, from.height)})` },
            ], { duration, easing, fill: 'both' }));
        }

        function sharedName(state, from, to, fromStyle, toStyle, duration) {
            const label = document.createElement('span');
            label.className = 'course-detail-shared-name';
            label.textContent = state.title.textContent;
            label.setAttribute('aria-hidden', 'true');
            Object.assign(label.style, {
                left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`,
                height: `${from.height}px`, fontSize: fromStyle.fontSize,
                lineHeight: fromStyle.lineHeight, fontWeight: fromStyle.fontWeight,
                color: toStyle.color,
            });
            state.modal.appendChild(label);
            state.label = label;
            state.animations.push(label.animate([
                { transform: 'translate(0, 0)', width: `${from.width}px`, height: `${from.height}px`,
                    fontSize: fromStyle.fontSize, lineHeight: fromStyle.lineHeight },
                { transform: `translate(${to.left - from.left}px, ${to.top - from.top}px)`,
                    width: `${to.width}px`, height: `${to.height}px`, fontSize: toStyle.fontSize,
                    lineHeight: toStyle.lineHeight },
            ], { duration, easing, fill: 'both' }));
        }

        function play(state, frames, { closing = false, duration, fromName, toName, fromStyle, toStyle, fromMark, toMark, opacities = [], backdropOpacity = '1' }) {
            const run = {};
            state.run = run;
            state.modal.classList.add('is-course-morphing');
            const surface = state.panel.animate(frames, { duration, easing, fill: 'both' });
            state.animations.push(surface);
            // 遮罩先退场，卡片继续收回；不要把整个弹窗一起淡出。
            if (state.backdrop) {
                state.animations.push(state.backdrop.animate(closing
                    ? [{ opacity: backdropOpacity }, { opacity: 0 }]
                    : [{ opacity: 0 }, { opacity: 1 }],
                { duration: closing ? 160 : 180, easing: 'ease-out', fill: 'both' }));
            }
            Array.from(state.panel.children).filter(child => child !== state.title).forEach((child, index) => {
                const opacity = opacities[index] || '1';
                state.animations.push(child.animate(closing
                    ? [{ opacity }, { opacity: 0 }]
                    : [{ opacity: 0 }, { opacity: 0, offset: 0.28 }, { opacity: 1 }],
                { duration: closing ? Math.min(90, duration) : duration, easing, fill: 'both' }));
            });
            sharedName(state, fromName, toName, fromStyle, toStyle, duration);
            sharedMark(state, fromMark, toMark, duration);
            surface.finished.then(() => {
                if (current !== state || state.run !== run) return;
                if (closing) {
                    const finish = state.finish;
                    reset(state.modal);
                    finish();
                } else stop(state);
            }).catch(() => {});
            // 所有附属动画也处理取消，避免快速关闭时产生未处理的 Promise rejection。
            state.animations.forEach(animation => animation.finished.catch(() => {}));
        }

        function open(modal, source) {
            reset();
            if (!modal || !source) return;
            modal.style.setProperty('--course-detail-color', window.getComputedStyle(source).getPropertyValue('--course-color').trim() || '#2055a2');
            const panel = modal.querySelector('.modal-content');
            if (panel) panel.scrollTop = 0;
            const body = modal.querySelector('#course-detail-body');
            if (body) body.scrollTop = 0;
            if (motion.matches) return;
            const title = modal.querySelector('#course-detail-name');
            const sourceName = source.querySelector('.course-card-name');
            if (!panel || !title || !sourceName || typeof panel.animate !== 'function') return;
            const start = source.getBoundingClientRect();
            const end = panel.getBoundingClientRect();
            if (!visible(start) || !visible(end)) return;
            const sourceStyle = window.getComputedStyle(source);
            const panelStyle = window.getComputedStyle(panel);
            const state = { modal, source, panel, title, sourceName, backdrop: modal.querySelector('.course-detail-backdrop'),
                animations: [], closing: false, run: null, label: null, mark: null };
            current = state;
            source.classList.add('is-detail-source');
            play(state, [
                { transform: transformBetween(start, end),
                    borderRadius: sourceRadius(sourceStyle, start, end) },
                { transform: 'translate(0, 0) scale(1, 1)',
                    borderRadius: panelStyle.borderRadius },
            ], { duration: 560, fromName: sourceName.getBoundingClientRect(), toName: title.getBoundingClientRect(),
                fromStyle: textStyle(sourceName), toStyle: textStyle(title), fromMark: markRect(source), toMark: markRect(panel) });
        }

        function close(modal, finish) {
            const state = current;
            if (!state || state.modal !== modal) return false;
            if (state.closing) return true;
            const destination = state.source.getBoundingClientRect();
            if (motion.matches || state.source.isConnected === false || !visible(destination)) {
                reset(modal);
                return false;
            }
            // 从当前渲染进度收回，展开中再次关闭也不跳到最终尺寸。
            const panelStyle = window.getComputedStyle(state.panel);
            const start = { transform: panelStyle.transform === 'none' ? 'translate(0, 0) scale(1, 1)' : panelStyle.transform,
                borderRadius: panelStyle.borderRadius };
            const fromName = (state.label || state.title).getBoundingClientRect();
            const fromStyle = textStyle(state.label || state.title);
            const fromMark = state.mark ? state.mark.getBoundingClientRect() : markRect(state.panel);
            const backdropOpacity = state.backdrop ? window.getComputedStyle(state.backdrop).opacity : '1';
            const opacities = Array.from(state.panel.children).filter(child => child !== state.title)
                .map(child => window.getComputedStyle(child).opacity);
            stop(state);
            const end = state.panel.getBoundingClientRect();
            const sourceStyle = window.getComputedStyle(state.source);
            state.closing = true;
            state.finish = finish;
            play(state, [start, { transform: transformBetween(destination, end),
                borderRadius: sourceRadius(sourceStyle, destination, end) }],
            { closing: true, duration: 240, fromName, toName: state.sourceName.getBoundingClientRect(),
                fromStyle, toStyle: textStyle(state.sourceName), fromMark, toMark: markRect(state.source), opacities, backdropOpacity });
            return true;
        }

        function settle() {
            if (!current) return;
            if (current.closing) {
                const finish = current.finish;
                reset();
                finish();
            } else stop(current);
        }
        window.addEventListener('resize', settle);
        if (typeof motion.addEventListener === 'function') motion.addEventListener('change', settle);
        return { open, close, reset };
    }

    if (typeof module !== 'undefined' && module.exports) module.exports = { createCourseDetailTransition };
    else root.courseDetailTransition = createCourseDetailTransition({ window: root, document: root.document });
})(typeof window !== 'undefined' ? window : globalThis);
