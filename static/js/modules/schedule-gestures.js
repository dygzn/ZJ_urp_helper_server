import { pageResources } from './lifecycle.js';
import { state } from './store.js';
import { changeWeek, displaySchedule, loadSchedule, updateScheduleDates } from './schedule.js';
import { closeSidebar, isDesktopWorkspace, syncDesktopWorkspaceLayout } from './navigation.js';
const resources = pageResources('schedule');

export const SCHEDULE_MIN_WEEK = 1;

export const SCHEDULE_MAX_WEEK = 25;

export const scheduleSwipeGesture = {
    pointerId: null,
    pointerType: null,
    swipe: null,
    startX: 0,
    startY: 0,
    lastX: 0,
    startTime: 0,
    width: 1,
    dragging: false,
    cancelled: false,
    moved: false,
    obstacleType: null,
    crossedObstacle: false,
    airborne: false,
    crashed: false,
    crashFinished: false,
    releasedAfterCrash: false,
    lastMoveTime: 0,
};

export const scheduleQueuedPointer = {
    pointerId: null,
    startX: 0,
    startY: 0,
    lastX: 0,
    startTime: 0,
    width: 1,
    cancelled: false,
    captured: false,
};

export function getScheduleSwipeElements() {
    const viewport = document.getElementById('schedule-content');
    const track = document.getElementById('schedule-swipe-track');
    if (!viewport || !track || typeof track.querySelectorAll !== 'function') return null;

    const dinoLane = viewport.querySelector('.schedule-dino-lane');
    const panels = Array.from(track.querySelectorAll('.schedule-week-panel'));
    const previous = panels.find(panel => panel.dataset.schedulePanel === 'previous');
    const current = panels.find(panel => panel.dataset.schedulePanel === 'current');
    const next = panels.find(panel => panel.dataset.schedulePanel === 'next');
    if (!previous || !current || !next) return null;

    return {
        viewport,
        track,
        panels,
        previous,
        current,
        next,
        dinoLane,
    };
}

export function ensureScheduleSwipePanels() {
    const swipe = getScheduleSwipeElements();
    if (!swipe || !swipe.current) return swipe;

    [swipe.previous, swipe.next].forEach(panel => {
        if (panel.querySelector('.schedule-grid')) return;
        panel.innerHTML = swipe.current.innerHTML;
        panel.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
    });
    return swipe;
}

export function getSchedulePanelElements(panel) {
    if (!panel) return {};
    return {
        scheduleDays: panel.querySelector('.schedule-days'),
        scheduleGrid: panel.querySelector('.schedule-grid'),
        scheduleHeader: panel.querySelector('.schedule-header'),
    };
}

export function getScheduleDataSource(fallbackSchedule = {}) {
    if (state.otherMajorScheduleData) return state.otherMajorScheduleData;
    if (state.cachedSchedule) return state.cachedSchedule;
    return fallbackSchedule || {};
}

export function getScheduleWeekPayload(source, week) {
    if (week < SCHEDULE_MIN_WEEK || week > SCHEDULE_MAX_WEEK) return {};
    const weekKey = String(week);
    if (!Object.prototype.hasOwnProperty.call(source || {}, weekKey)) return {};
    return { [weekKey]: source[weekKey] };
}

export function setScheduleSwipeTransform(offset, { animate = false } = {}) {
    const swipe = getScheduleSwipeElements();
    if (!swipe) return;

    swipe.track.classList.toggle('is-animating', animate);
    swipe.track.style.transform = `translate3d(calc(-33.333333% + ${offset}px), 0, 0)`;
}

export function animateScheduleHeight(track, fromHeight, toHeight, hold = false) {
    state.scheduleHeightAnimation?.cancel();
    state.scheduleHeightAnimation = null;
    if (!track?.animate || !Number.isFinite(fromHeight) || !Number.isFinite(toHeight)
        || fromHeight <= 0 || toHeight <= 0 || Math.abs(fromHeight - toHeight) < 1
        || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    const animation = track.animate([
        { height: `${fromHeight}px` }, { height: `${toHeight}px` },
    ], {
        duration: 360,
        easing: 'cubic-bezier(0.22, 0.72, 0.18, 1)',
        // 横向滑动完成前保持目标高度；重新渲染后恢复自然布局。
        fill: hold ? 'forwards' : 'none',
    });
    state.scheduleHeightAnimation = animation;
    animation.onfinish = () => {
        if (!hold && state.scheduleHeightAnimation === animation) state.scheduleHeightAnimation = null;
    };
}

export function applyScheduleSwipeResistance(deltaX) {
    const atFirstWeek = state.currentWeek <= SCHEDULE_MIN_WEEK && deltaX > 0;
    const atLastWeek = state.currentWeek >= SCHEDULE_MAX_WEEK && deltaX < 0;
    return atFirstWeek || atLastWeek ? deltaX * 0.24 : deltaX;
}

export function getScheduleSwipeWidth(viewport) {
    if (!viewport) return 1;
    const rect = typeof viewport.getBoundingClientRect === 'function'
        ? viewport.getBoundingClientRect()
        : null;
    return Math.max(viewport.clientWidth || rect?.width || 1, 1);
}

export function clearScheduleDinoGestureTimers({ includeCrash = true } = {}) {
    if (state.scheduleDinoHoldTimer !== null) {
        resources.clearTimeout(state.scheduleDinoHoldTimer);
        state.scheduleDinoHoldTimer = null;
    }
    if (state.scheduleDinoAirborneTimer !== null) {
        resources.clearTimeout(state.scheduleDinoAirborneTimer);
        state.scheduleDinoAirborneTimer = null;
    }
    if (includeCrash && state.scheduleDinoCrashTimer !== null) {
        resources.clearTimeout(state.scheduleDinoCrashTimer);
        state.scheduleDinoCrashTimer = null;
    }
}

export function finishScheduleDinoCrash(swipe = getScheduleSwipeElements()) {
    if (!swipe) return;
    clearScheduleDinoGestureTimers();
    swipe.viewport.classList.remove(
        'is-swiping',
        'is-settling',
        'is-dino-jumping',
        'is-dino-crashed',
        'has-dino-obstacle',
    );
    swipe.track.classList.remove('is-dragging', 'is-animating');
    swipe.track.style.setProperty('--schedule-swipe-direction', '0');
    swipe.track.style.setProperty('--schedule-swipe-progress', '0');
    if (swipe.dinoLane) {
        swipe.dinoLane.style.setProperty('--dino-obstacle-progress', '0');
        swipe.dinoLane.style.setProperty('--dino-obstacle-shift', '140px');
        swipe.dinoLane.style.setProperty('--dino-fireball-distance', '240px');
        swipe.dinoLane.style.setProperty('--dino-drag-lift', '0px');
        swipe.dinoLane.dataset.blocked = 'false';
    }
    setScheduleSwipeTransform(0);
    resetScheduleSwipeGesture();
}

export function crashScheduleDino() {
    const swipe = getScheduleSwipeElements();
    if (!swipe || scheduleSwipeGesture.crashed) return;

    scheduleSwipeGesture.crashed = true;
    scheduleSwipeGesture.airborne = false;
    scheduleSwipeGesture.dragging = false;
    clearScheduleDinoGestureTimers({ includeCrash: false });
    if (swipe.dinoLane) swipe.dinoLane.style.setProperty('--dino-obstacle-shift', '-20px');
    swipe.viewport.classList.remove('is-swiping', 'is-dino-jumping');
    swipe.viewport.classList.add('is-dino-crashed');
    swipe.track.classList.remove('is-dragging');
    setScheduleSwipeTransform(0, { animate: true });

    state.scheduleDinoCrashTimer = resources.setTimeout(() => {
        state.scheduleDinoCrashTimer = null;
        scheduleSwipeGesture.crashFinished = true;
        if (scheduleSwipeGesture.pointerId === null || scheduleSwipeGesture.releasedAfterCrash) {
            finishScheduleDinoCrash(swipe);
        }
    }, 800);
}

export function armScheduleDinoHoldTimer() {
    if (state.scheduleDinoHoldTimer !== null) resources.clearTimeout(state.scheduleDinoHoldTimer);
    scheduleSwipeGesture.lastMoveTime = Date.now();
    state.scheduleDinoHoldTimer = resources.setTimeout(() => {
        state.scheduleDinoHoldTimer = null;
        if (shouldCrashScheduleDino({
            airborne: scheduleSwipeGesture.airborne,
            pointerDown: scheduleSwipeGesture.pointerId !== null,
            idleMs: Date.now() - scheduleSwipeGesture.lastMoveTime,
        })) {
            crashScheduleDino();
        }
    }, 610);
}

export function resetScheduleSwipeGesture() {
    if (state.scheduleSwipeFrame !== null) resources.cancelAnimationFrame(state.scheduleSwipeFrame);
    state.scheduleSwipeFrame = null;
    state.scheduleSwipePendingEvent = null;
    scheduleSwipeGesture.pointerId = null;
    scheduleSwipeGesture.pointerType = null;
    scheduleSwipeGesture.swipe = null;
    scheduleSwipeGesture.startX = 0;
    scheduleSwipeGesture.startY = 0;
    scheduleSwipeGesture.lastX = 0;
    scheduleSwipeGesture.startTime = 0;
    scheduleSwipeGesture.width = 1;
    scheduleSwipeGesture.dragging = false;
    scheduleSwipeGesture.cancelled = false;
    scheduleSwipeGesture.moved = false;
    scheduleSwipeGesture.obstacleType = null;
    scheduleSwipeGesture.crossedObstacle = false;
    scheduleSwipeGesture.airborne = false;
    scheduleSwipeGesture.crashed = false;
    scheduleSwipeGesture.crashFinished = false;
    scheduleSwipeGesture.releasedAfterCrash = false;
    scheduleSwipeGesture.lastMoveTime = 0;
}

export function finishScheduleSwipeTransition() {
    const transition = state.scheduleSwipeTransition;
    const swipe = getScheduleSwipeElements();
    if (!transition || !swipe) return;

    // 轨道可能几乎没有剩余位移；不能用它的结束事件提前清除恐龙动画。
    const remaining = transition.finishNotBefore - performance.now();
    if (remaining > 0) {
        if (state.scheduleSwipeTransitionTimer !== null) resources.clearTimeout(state.scheduleSwipeTransitionTimer);
        state.scheduleSwipeTransitionTimer = resources.setTimeout(finishScheduleSwipeTransition, remaining);
        return;
    }

    state.scheduleSwipeTransition = null;
    if (state.scheduleSwipeTransitionTimer !== null) {
        resources.clearTimeout(state.scheduleSwipeTransitionTimer);
        state.scheduleSwipeTransitionTimer = null;
    }
    swipe.track.removeEventListener('transitionend', transition.onTransitionEnd);
    swipe.track.classList.remove('is-animating', 'is-changing');
    swipe.viewport.classList.remove(
        'is-settling',
        'is-dino-jumping',
        'is-dino-reversing',
        'is-dino-fireball',
        'is-dino-completing',
        'is-dino-button-jump',
        'is-dino-crashed',
        'has-dino-obstacle',
    );
    swipe.track.style.setProperty('--schedule-swipe-direction', '0');
    swipe.track.style.setProperty('--schedule-swipe-progress', '0');
    if (swipe.dinoLane) {
        swipe.dinoLane.style.setProperty('--dino-obstacle-progress', '0');
        swipe.dinoLane.style.setProperty('--dino-obstacle-shift', '140px');
        swipe.dinoLane.style.setProperty('--dino-fireball-distance', '240px');
        swipe.dinoLane.style.setProperty('--dino-drag-lift', '0px');
        swipe.dinoLane.dataset.blocked = 'false';
    }

    if (!transition.shouldChange) {
        swipe.panels.forEach(panel => panel.classList.remove('is-swipe-target'));
        setScheduleSwipeTransform(0);
        flushQueuedScheduleSwipe();
        return;
    }

    state.currentWeek = transition.week;
    localStorage.setItem('current_week', state.currentWeek);
    updateScheduleDates(state.currentWeek);
    swipe.panels.forEach(panel => panel.classList.remove('is-swipe-target'));
    setScheduleSwipeTransform(0);

    if (state.otherMajorScheduleData) {
        displaySchedule(getScheduleWeekPayload(state.otherMajorScheduleData, state.currentWeek));
    } else {
        loadSchedule(state.currentWeek);
    }
    flushQueuedScheduleSwipe();
}

export function animateScheduleSwipeTo(result, width, dinoReleaseAction = 'idle') {
    const swipe = getScheduleSwipeElements();
    if (!swipe) return;

    const targetPanel = result.direction > 0 ? swipe.next : swipe.previous;
    swipe.panels.forEach(panel => panel.classList.remove('is-swipe-target'));
    if (result.shouldChange && targetPanel) targetPanel.classList.add('is-swipe-target');
    if (result.shouldChange && targetPanel) {
        animateScheduleHeight(swipe.track, swipe.track.getBoundingClientRect?.().height,
            targetPanel.scrollHeight, true);
    }

    const transition = {
        shouldChange: result.shouldChange,
        week: result.week,
        finishNotBefore: performance.now() + (
            window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 380
        ),
        onTransitionEnd: event => {
            if (event.target === swipe.track && event.propertyName === 'transform') {
                finishScheduleSwipeTransition();
            }
        },
    };
    state.scheduleSwipeTransition = transition;
    swipe.viewport.classList.remove('is-swiping', 'is-dino-fireball', 'is-dino-reversing', 'is-dino-completing');
    swipe.viewport.classList.add('is-settling');
    swipe.track.classList.toggle('is-changing', result.shouldChange);
    swipe.track.style.setProperty('--schedule-swipe-direction', String(result.direction));
    swipe.track.addEventListener('transitionend', transition.onTransitionEnd);
    if (dinoReleaseAction === 'fireball') {
        swipe.viewport.classList.remove('is-dino-jumping');
        swipe.viewport.classList.add('is-dino-fireball');
    } else if (dinoReleaseAction === 'reverse-jump') {
        swipe.viewport.classList.remove('is-dino-jumping');
        swipe.viewport.classList.add('is-dino-reversing');
    } else if (dinoReleaseAction === 'complete') {
        swipe.viewport.classList.add('is-dino-completing');
        if (!swipe.viewport.classList.contains('is-dino-jumping')) {
            if (swipe.dinoLane) {
                swipe.dinoLane.style.setProperty('--dino-obstacle-progress', '1');
                swipe.dinoLane.style.setProperty('--dino-obstacle-shift', '0px');
            }
            swipe.viewport.classList.add('is-dino-jumping');
        }
    } else {
        swipe.viewport.classList.remove('has-dino-obstacle', 'is-dino-jumping');
    }
    setScheduleSwipeTransform(result.direction * -width, { animate: true });
    state.scheduleSwipeTransitionTimer = resources.setTimeout(finishScheduleSwipeTransition, 460);
}

export function flushQueuedScheduleSwipe() {
    if (!state.scheduleQueuedSwipe || state.scheduleSwipeTransition || scheduleSwipeGesture.pointerId !== null
        || scheduleQueuedPointer.pointerId !== null) return;
    const direction = Math.sign(state.scheduleQueuedSwipe);
    state.scheduleQueuedSwipe -= direction;
    resources.requestAnimationFrame(() => {
        if (state.scheduleSwipeTransition || scheduleSwipeGesture.pointerId !== null
            || scheduleQueuedPointer.pointerId !== null) {
            state.scheduleQueuedSwipe += direction;
            return;
        }
        changeWeek(direction, true);
    });
}

export function resetQueuedScheduleSwipe() {
    if (scheduleQueuedPointer.captured) {
        const swipe = getScheduleSwipeElements();
        if (swipe && typeof swipe.viewport.releasePointerCapture === 'function') {
            try {
                swipe.viewport.releasePointerCapture(scheduleQueuedPointer.pointerId);
            } catch (error) {
        if (error?.name === 'AbortError') return;
                // 页面切换时指针可能已释放。
            }
        }
    }
    scheduleQueuedPointer.pointerId = null;
    scheduleQueuedPointer.captured = false;
    state.scheduleQueuedSwipe = 0;
}

export function handleQueuedSchedulePointerMove(event) {
    if (event.pointerId !== scheduleQueuedPointer.pointerId) return false;
    scheduleQueuedPointer.lastX = event.clientX;
    const deltaX = event.clientX - scheduleQueuedPointer.startX;
    const deltaY = event.clientY - scheduleQueuedPointer.startY;
    if (Math.abs(deltaY) > 8 && Math.abs(deltaY) > Math.abs(deltaX)) {
        scheduleQueuedPointer.cancelled = true;
    } else if (!scheduleQueuedPointer.cancelled && Math.abs(deltaX) > 8) {
        if (!scheduleQueuedPointer.captured) {
            const swipe = getScheduleSwipeElements();
            if (swipe && typeof swipe.viewport.setPointerCapture === 'function') {
                swipe.viewport.setPointerCapture(event.pointerId);
                scheduleQueuedPointer.captured = true;
            }
        }
        if (event.cancelable) event.preventDefault();
    }
    return true;
}

export function handleQueuedSchedulePointerEnd(event, cancelled = false) {
    if (event.pointerId !== scheduleQueuedPointer.pointerId) return false;
    const swipe = getScheduleSwipeElements();
    if (scheduleQueuedPointer.captured && swipe && typeof swipe.viewport.releasePointerCapture === 'function') {
        try {
            swipe.viewport.releasePointerCapture(event.pointerId);
        } catch (error) {
        if (error?.name === 'AbortError') return;
            // 浏览器可能已释放指针。
        }
    }
    const deltaX = (typeof event.clientX === 'number' ? event.clientX : scheduleQueuedPointer.lastX)
        - scheduleQueuedPointer.startX;
    const duration = Date.now() - scheduleQueuedPointer.startTime;
    const baseWeek = Math.min(SCHEDULE_MAX_WEEK, Math.max(SCHEDULE_MIN_WEEK,
        (state.scheduleSwipeTransition?.week ?? state.currentWeek) + state.scheduleQueuedSwipe));
    const result = cancelled || scheduleQueuedPointer.cancelled
        ? { shouldChange: false }
        : resolveScheduleSwipe({
            deltaX,
            duration,
            viewportWidth: scheduleQueuedPointer.width,
            currentWeek: baseWeek,
            minWeek: SCHEDULE_MIN_WEEK,
            maxWeek: SCHEDULE_MAX_WEEK,
        });
    scheduleQueuedPointer.pointerId = null;
    scheduleQueuedPointer.captured = false;
    if (result.shouldChange) {
        state.scheduleQueuedSwipe += result.direction;
        state.suppressScheduleSwipeClick = true;
        flushQueuedScheduleSwipe();
    }
    return true;
}

export function handleSchedulePointerDown(event) {
    const swipe = getScheduleSwipeElements();
    if (!swipe || scheduleSwipeGesture.pointerId !== null || scheduleQueuedPointer.pointerId !== null) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // 新一次按下与上一轮滑动的合成点击无关，课程按钮也需要清除旧标记。
    state.suppressScheduleSwipeClick = false;
    if (event.target.closest && event.target.closest('button, select, a, input, textarea')) return;

    if (state.scheduleSwipeTransition) {
        scheduleQueuedPointer.pointerId = event.pointerId;
        scheduleQueuedPointer.startX = event.clientX;
        scheduleQueuedPointer.startY = event.clientY;
        scheduleQueuedPointer.lastX = event.clientX;
        scheduleQueuedPointer.startTime = Date.now();
        scheduleQueuedPointer.width = getScheduleSwipeWidth(swipe.viewport);
        scheduleQueuedPointer.cancelled = false;
        scheduleQueuedPointer.captured = false;
        return;
    }

    scheduleSwipeGesture.pointerId = event.pointerId;
    scheduleSwipeGesture.pointerType = event.pointerType;
    scheduleSwipeGesture.swipe = swipe;
    scheduleSwipeGesture.startX = event.clientX;
    scheduleSwipeGesture.startY = event.clientY;
    scheduleSwipeGesture.lastX = event.clientX;
    scheduleSwipeGesture.startTime = Date.now();
    scheduleSwipeGesture.width = getScheduleSwipeWidth(swipe.viewport);
    scheduleSwipeGesture.dragging = false;
    scheduleSwipeGesture.cancelled = false;
    scheduleSwipeGesture.moved = false;
    scheduleSwipeGesture.obstacleType = null;
    scheduleSwipeGesture.crossedObstacle = false;
    scheduleSwipeGesture.airborne = false;
    scheduleSwipeGesture.crashed = false;
    scheduleSwipeGesture.crashFinished = false;
    scheduleSwipeGesture.releasedAfterCrash = false;
    scheduleSwipeGesture.lastMoveTime = Date.now();
    clearScheduleDinoGestureTimers();
    swipe.viewport.classList.remove(
        'is-dino-jumping',
        'is-dino-reversing',
        'is-dino-fireball',
        'is-dino-completing',
        'is-dino-button-jump',
        'is-dino-crashed',
        'has-dino-obstacle',
    );
    if (swipe.dinoLane) {
        swipe.dinoLane.style.setProperty('--dino-obstacle-progress', '0');
        swipe.dinoLane.style.setProperty('--dino-obstacle-shift', '140px');
        swipe.dinoLane.style.setProperty('--dino-fireball-distance', '240px');
        swipe.dinoLane.style.setProperty('--dino-drag-lift', '0px');
        swipe.dinoLane.dataset.blocked = 'false';
    }
}

export function handleSchedulePointerMove(event) {
    if (handleQueuedSchedulePointerMove(event)) return;
    if (event.pointerId !== scheduleSwipeGesture.pointerId) return;
    if (scheduleSwipeGesture.dragging && event.cancelable) event.preventDefault();
    state.scheduleSwipePendingEvent = event;
    if (state.scheduleSwipeFrame !== null) return;
    state.scheduleSwipeFrame = resources.requestAnimationFrame(() => {
        state.scheduleSwipeFrame = null;
        const pending = state.scheduleSwipePendingEvent;
        state.scheduleSwipePendingEvent = null;
        if (pending) renderSchedulePointerMove(pending);
    });
}

export function renderSchedulePointerMove(event) {
    const swipe = scheduleSwipeGesture.swipe || getScheduleSwipeElements();
    if (!swipe || event.pointerId !== scheduleSwipeGesture.pointerId || state.scheduleSwipeTransition) return;

    if (scheduleSwipeGesture.crashed) {
        if (event.cancelable) event.preventDefault();
        return;
    }

    const deltaX = event.clientX - scheduleSwipeGesture.startX;
    const deltaY = event.clientY - scheduleSwipeGesture.startY;
    scheduleSwipeGesture.lastX = event.clientX;

    if (!scheduleSwipeGesture.dragging) {
        if (scheduleSwipeGesture.cancelled || (Math.abs(deltaX) < 8 && Math.abs(deltaY) < 8)) return;
        if (Math.abs(deltaY) > Math.abs(deltaX)) {
            scheduleSwipeGesture.cancelled = true;
            return;
        }

        scheduleSwipeGesture.dragging = true;
        scheduleSwipeGesture.moved = true;
        scheduleSwipeGesture.obstacleType = pickScheduleDinoObstacle();
        if (typeof swipe.viewport.setPointerCapture === 'function') {
            swipe.viewport.setPointerCapture(event.pointerId);
        }
        swipe.viewport.classList.add('is-swiping');
        swipe.viewport.classList.add('has-dino-obstacle');
        swipe.track.classList.add('is-dragging');
        if (swipe.dinoLane) swipe.dinoLane.dataset.obstacle = scheduleSwipeGesture.obstacleType;
    }

    if (!scheduleSwipeGesture.dragging) return;
    if (event.cancelable) event.preventDefault();

    const offset = applyScheduleSwipeResistance(deltaX);
    const dinoCue = resolveScheduleDinoCue({
        deltaX,
        viewportWidth: scheduleSwipeGesture.width,
        currentWeek: state.currentWeek,
        minWeek: SCHEDULE_MIN_WEEK,
        maxWeek: SCHEDULE_MAX_WEEK,
    });
    if (swipe.dinoLane) {
        const dinoDirection = dinoCue.direction < 0 ? 'previous' : 'next';
        const blocked = String(dinoCue.blocked);
        if (swipe.dinoLane.dataset.direction !== dinoDirection) swipe.dinoLane.dataset.direction = dinoDirection;
        if (swipe.dinoLane.dataset.blocked !== blocked) swipe.dinoLane.dataset.blocked = blocked;
        const obstacleShift = dinoCue.blocked
            ? Math.max(24, (1 - dinoCue.obstacleProgress) * 140)
            : (1 - dinoCue.obstacleProgress) * 140;
        // 同一位移决定起跳和落地；暂停、反向拖动也保持安全间距。
        const lift = resolveScheduleDinoLift(obstacleShift, dinoCue.blocked);
        swipe.dinoLane.style.setProperty('--dino-drag-lift', `${-lift}px`);
        scheduleSwipeGesture.airborne = lift > 0;
        if (scheduleSwipeGesture.airborne && scheduleSwipeGesture.pointerType === 'mouse') {
            armScheduleDinoHoldTimer();
        } else if (state.scheduleDinoHoldTimer !== null) {
            resources.clearTimeout(state.scheduleDinoHoldTimer);
            state.scheduleDinoHoldTimer = null;
        }
        swipe.dinoLane.style.setProperty('--dino-obstacle-shift', `${obstacleShift}px`);
        swipe.dinoLane.style.setProperty('--dino-fireball-distance', `${100 + obstacleShift}px`);
    }
    scheduleSwipeGesture.crossedObstacle = dinoCue.crossedObstacle;
    swipe.track.style.transform = `translate3d(calc(-33.333333% + ${offset}px), 0, 0)`;
}

export function handleSchedulePointerEnd(event, cancelled = false) {
    if (handleQueuedSchedulePointerEnd(event, cancelled)) return;
    if (event.pointerId === scheduleSwipeGesture.pointerId && state.scheduleSwipePendingEvent) {
        resources.cancelAnimationFrame(state.scheduleSwipeFrame);
        state.scheduleSwipeFrame = null;
        const pending = state.scheduleSwipePendingEvent;
        state.scheduleSwipePendingEvent = null;
        renderSchedulePointerMove(pending);
    }
    const swipe = scheduleSwipeGesture.swipe || getScheduleSwipeElements();
    if (!swipe || event.pointerId !== scheduleSwipeGesture.pointerId) return;

    if (scheduleSwipeGesture.crashed) {
        if (typeof swipe.viewport.releasePointerCapture === 'function') {
            try {
                swipe.viewport.releasePointerCapture(event.pointerId);
            } catch (error) {
        if (error?.name === 'AbortError') return;
                // 撞击后指针可能已经由浏览器释放。
            }
        }
        scheduleSwipeGesture.pointerId = null;
        scheduleSwipeGesture.releasedAfterCrash = true;
        if (scheduleSwipeGesture.crashFinished) finishScheduleDinoCrash(swipe);
        return;
    }

    const wasDragging = scheduleSwipeGesture.dragging;
    const deltaX = (typeof event.clientX === 'number' ? event.clientX : scheduleSwipeGesture.lastX)
        - scheduleSwipeGesture.startX;
    const duration = Date.now() - scheduleSwipeGesture.startTime;
    const width = scheduleSwipeGesture.width;
    const hadObstacle = Boolean(scheduleSwipeGesture.obstacleType);
    const crossedObstacle = scheduleSwipeGesture.crossedObstacle;
    state.suppressScheduleSwipeClick = scheduleSwipeGesture.moved;
    clearScheduleDinoGestureTimers();

    if (typeof swipe.viewport.releasePointerCapture === 'function') {
        try {
            swipe.viewport.releasePointerCapture(event.pointerId);
        } catch (error) {
        if (error?.name === 'AbortError') return;
            // 指针已经释放时浏览器可能抛错，不影响周次切换。
        }
    }
    resetScheduleSwipeGesture();

    if (!wasDragging) {
        swipe.viewport.classList.remove('is-swiping', 'is-dino-jumping', 'has-dino-obstacle');
        return;
    }

    swipe.track.classList.remove('is-dragging');
    const result = cancelled
        ? { shouldChange: false, direction: 0, week: state.currentWeek }
        : resolveScheduleSwipe({
            deltaX,
            duration,
            viewportWidth: width,
            currentWeek: state.currentWeek,
            minWeek: SCHEDULE_MIN_WEEK,
            maxWeek: SCHEDULE_MAX_WEEK,
        });
    const dinoReleaseAction = resolveScheduleDinoRelease({
        hadObstacle,
        crossedObstacle,
        shouldChange: result.shouldChange,
    });
    // 松手后从拖动时的高度落地，避免快扫时回到地面重播起跳。
    animateScheduleSwipeTo(result, width, dinoReleaseAction);
}

export function handleScheduleSwipeClick(event) {
    if (!state.suppressScheduleSwipeClick) return;
    state.suppressScheduleSwipeClick = false;
    event.preventDefault();
    event.stopPropagation();
}

export function initScheduleSwipe() {
    const swipe = ensureScheduleSwipePanels();
    if (!swipe || swipe.viewport.dataset.scheduleSwipeReady === 'true') return;

    swipe.viewport.dataset.scheduleSwipeReady = 'true';
    resources.listen(swipe.viewport, 'pointerdown', handleSchedulePointerDown);
    resources.listen(swipe.viewport, 'pointermove', handleSchedulePointerMove);
    resources.listen(swipe.viewport, 'pointerup', event => handleSchedulePointerEnd(event));
    resources.listen(swipe.viewport, 'pointercancel', event => handleSchedulePointerEnd(event, true));
    resources.listen(swipe.viewport, 'click', handleScheduleSwipeClick, true);
}

export const scheduleActionReveal = {
    distance: 0,
    touchDirection: null,
    touchId: null,
    touchStartX: 0,
    touchStartY: 0,
    lastTouchY: 0,
    horizontalTouch: false,
    wheelTimer: null,
};

export function resetScheduleActionPull() {
    const pull = document.getElementById('schedule-actions-pull');
    scheduleActionReveal.distance = 0;
    if (scheduleActionReveal.wheelTimer !== null && typeof window !== 'undefined') {
        resources.clearTimeout(scheduleActionReveal.wheelTimer);
        scheduleActionReveal.wheelTimer = null;
    }
    if (!pull) return;
    const fill = pull.querySelector('.schedule-actions-pull-fill');
    if (fill) fill.style.width = '0%';
    pull.classList.remove('is-pulling', 'is-ready');
    const label = pull.querySelector('.schedule-actions-pull-label');
    if (label) label.textContent = '继续上滑，展开日程表操作';
}

export function updateScheduleActionPull(distance, direction = 'up', commit = true) {
    if (scheduleActionsUseMenu()) return resetScheduleActionPull();
    const pull = document.getElementById('schedule-actions-pull');
    const panel = document.getElementById('schedule-actions');
    if (!pull || !panel || (direction === 'up' && panel.classList.contains('is-open'))
        || (direction === 'down' && !panel.classList.contains('is-open'))) return;
    if (distance <= 0) {
        resetScheduleActionPull();
        return;
    }
    scheduleActionReveal.distance = Math.max(0, distance);
    const state = resolveScheduleActionPull(scheduleActionReveal.distance, direction === 'down' ? 28 : 220);
    if (state.shouldOpen && commit) {
        if (direction === 'down') hideScheduleActions(true, true);
        else showScheduleActions();
        return;
    }
    const fill = pull.querySelector('.schedule-actions-pull-fill');
    if (fill) fill.style.width = `${Math.floor(state.progress * 100)}%`;
    // 明显滑动后才提示；回退时留一点余量，避免临界距离附近闪烁。
    const showHint = direction === 'up'
        && (distance >= 80 || (pull.classList.contains('is-pulling') && distance >= 64));
    pull.classList.toggle('is-pulling', showHint);
    const label = pull.querySelector('.schedule-actions-pull-label');
    if (label) label.textContent = direction === 'down'
        ? (state.shouldOpen ? '松手收起日程表操作'
            : state.progress >= 0.8 ? '再向下滑一点' : '继续下滑，收起日程表操作')
        : (state.shouldOpen ? '松手展开日程表操作'
            : state.progress >= 0.8 ? '再向上滑一点' : '继续上滑，展开日程表操作');
}

export function scheduleActionsUseMenu() {
    return Boolean(typeof window !== 'undefined' && window.ScheduleActionsMenu?.isEnabled?.());
}

export function resetScheduleActionGesture() {
    scheduleActionReveal.touchId = null;
    scheduleActionReveal.touchDirection = null;
    scheduleActionReveal.horizontalTouch = false;
    resetScheduleActionPull();
}

export function showScheduleActions() {
    if (scheduleActionsUseMenu()) return window.ScheduleActionsMenu.open();
    const panel = document.getElementById('schedule-actions');
    if (!panel || panel.classList.contains('is-open')) return;
    resetScheduleActionPull();
    panel.classList.add('is-open');
    panel.removeAttribute('inert');
    panel.setAttribute('aria-hidden', 'false');
    document.getElementById('schedule-mobile-more')?.setAttribute('aria-expanded', 'true');
}

export function toggleScheduleActions() {
    if (scheduleActionsUseMenu()) return window.ScheduleActionsMenu.toggle();
    const panel = document.getElementById('schedule-actions');
    if (panel?.classList.contains('is-open')) hideScheduleActions(false);
    else showScheduleActions();
}

export function hideScheduleActions(focusTimetable = true, preventScroll = false) {
    if (scheduleActionsUseMenu()) return window.ScheduleActionsMenu.close({ restoreFocus: focusTimetable });
    if (isDesktopWorkspace()) {
        showScheduleActions();
        return;
    }
    const panel = document.getElementById('schedule-actions');
    if (!panel || !panel.classList) return;
    if (focusTimetable && typeof panel.contains === 'function' && panel.contains(document.activeElement)) {
        const timetable = document.getElementById('schedule-content');
        if (timetable && typeof timetable.focus === 'function') {
            timetable.focus(preventScroll ? { preventScroll: true } : undefined);
        }
    }
    panel.classList.remove('is-open');
    panel.setAttribute('inert', '');
    panel.setAttribute('aria-hidden', 'true');
    document.getElementById('schedule-mobile-more')?.setAttribute('aria-expanded', 'false');
    resetScheduleActionPull();
}

export function scheduleActionTouch(event) {
    return Array.from(event.touches || []).find(touch => touch.identifier === scheduleActionReveal.touchId);
}

export function handleScheduleActionTouchStart(event) {
    if (scheduleActionsUseMenu() || isDesktopWorkspace()) return;
    const panel = document.getElementById('schedule-actions');
    const touch = event.touches && event.touches[0];
    if (!panel || !touch) return;
    if (event.touches.length !== 1) {
        scheduleActionReveal.touchId = null;
        resetScheduleActionPull();
        return;
    }
    const isOpen = panel.classList.contains('is-open');
    if (event.target?.closest?.('input, select, textarea, .schedule-unplaced-exams')) return;
    resetScheduleActionPull();
    scheduleActionReveal.touchId = touch.identifier;
    scheduleActionReveal.touchStartX = touch.clientX;
    scheduleActionReveal.touchStartY = touch.clientY;
    scheduleActionReveal.lastTouchY = touch.clientY;
    scheduleActionReveal.touchDirection = isOpen ? 'down' : 'up';
    scheduleActionReveal.horizontalTouch = false;
}

export function handleScheduleActionTouchMove(event) {
    if (scheduleActionsUseMenu()) return;
    const panel = document.getElementById('schedule-actions');
    const touch = scheduleActionTouch(event);
    if (!panel || !touch || scheduleActionReveal.horizontalTouch) return;
    const deltaX = touch.clientX - scheduleActionReveal.touchStartX;
    const deltaY = touch.clientY - scheduleActionReveal.touchStartY;
    if (Math.abs(deltaX) > 10 && Math.abs(deltaX) > Math.abs(deltaY)) {
        scheduleActionReveal.horizontalTouch = true;
        resetScheduleActionPull();
        return;
    }
    const step = (scheduleActionReveal.lastTouchY - touch.clientY)
        * (scheduleActionReveal.touchDirection === 'down' ? -1 : 1);
    scheduleActionReveal.lastTouchY = touch.clientY;
    const direction = scheduleActionReveal.touchDirection;
    const distance = Math.max(0, scheduleActionReveal.distance + step);
    if (event.cancelable) event.preventDefault();
    updateScheduleActionPull(distance, direction, direction === 'down');
    if (direction === 'down' && !panel.classList.contains('is-open')) {
        scheduleActionReveal.touchId = null;
        scheduleActionReveal.touchDirection = null;
    }
}

export function handleScheduleActionTouchEnd(event) {
    if (scheduleActionsUseMenu()) return;
    if (scheduleActionReveal.touchId === null || scheduleActionTouch(event)) return;
    const direction = scheduleActionReveal.touchDirection;
    const distance = scheduleActionReveal.distance;
    scheduleActionReveal.touchId = null;
    scheduleActionReveal.touchDirection = null;
    scheduleActionReveal.horizontalTouch = false;
    resetScheduleActionPull();
    if (event.type !== 'touchcancel' && direction && distance >= (direction === 'down' ? 28 : 220)) {
        if (direction === 'down') hideScheduleActions(true, true);
        else showScheduleActions();
    }
}

export function handleScheduleActionWheel(event) {
    if (scheduleActionsUseMenu() || isDesktopWorkspace()) return;
    const panel = document.getElementById('schedule-actions');
    if (!panel) return;
    const isOpen = panel.classList.contains('is-open');
    const direction = isOpen ? 'down' : 'up';
    if (event.target?.closest?.('input, select, textarea, .schedule-unplaced-exams')) return;
    if ((isOpen && event.deltaY >= 0)
        || (!isOpen && (event.deltaY <= 0))) {
        if (scheduleActionReveal.distance > 0) resetScheduleActionPull();
        return;
    }
    if (event.cancelable) event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
    updateScheduleActionPull(scheduleActionReveal.distance + Math.min(Math.abs(event.deltaY * unit), 60), direction, direction === 'down');
    if (scheduleActionReveal.wheelTimer !== null) resources.clearTimeout(scheduleActionReveal.wheelTimer);
    if (scheduleActionReveal.distance > 0) {
        scheduleActionReveal.wheelTimer = resources.setTimeout(() => {
            if (scheduleActionReveal.distance >= 220) showScheduleActions();
            else resetScheduleActionPull();
        }, 240);
    }
}

export function handleScheduleActionKeyDown(event) {
    if (scheduleActionsUseMenu() || state.uiModalState.activeModal || isDesktopWorkspace()) return;
    if (event.target?.closest?.('input, select, textarea, .schedule-unplaced-exams')) return;
    const page = document.getElementById('page-schedule');
    const panel = document.getElementById('schedule-actions');
    if (!page || !page.classList.contains('active') || !panel
        || panel.classList.contains('is-open')) return;
    if (event.key !== 'PageDown' && event.key !== 'ArrowDown') return;
    if (event.cancelable) event.preventDefault();
    showScheduleActions();
}

export function createMobileScheduleLayout() {
    const container = document.querySelector('#page-schedule .schedule-container');
    const toolbar = container?.querySelector('.schedule-toolbar');
    const week = container?.querySelector('.schedule-week-toolbar');
    const controls = week?.querySelector('.schedule-week-controls');
    const help = controls?.querySelector('.schedule-gesture-help');
    const pull = document.getElementById('schedule-actions-pull');
    const gesture = document.getElementById('schedule-mobile-gesture');
    const actions = document.getElementById('schedule-mobile-actions');
    const update = document.getElementById('update-schedule-btn');
    if (!container || !toolbar || !week || !controls || !gesture || !actions) return () => {};
    return mobile => {
        if (mobile) {
            container.prepend(week);
            if (help) gesture.append(help);
            if (pull) gesture.append(pull);
            if (update) actions.prepend(update);
        } else {
            toolbar.prepend(week);
            if (help) controls.append(help);
            if (pull) controls.append(pull);
        }
    };
}

export function initScheduleActions() {
    const page = document.getElementById('page-schedule');
    const panel = document.getElementById('schedule-actions');
    if (!page || !panel || page.dataset.scheduleActionsReady === 'true') return;
    page.dataset.scheduleActionsReady = 'true';
    const desktopQuery = window.matchMedia?.('(min-width: 1100px)');
    const syncDesktopLayout = syncDesktopWorkspaceLayout;
    const mobileQuery = window.matchMedia?.('(max-width: 768px)');
    const syncMobileLayout = createMobileScheduleLayout();
    const syncWorkspace = () => {
        syncDesktopLayout(Boolean(desktopQuery?.matches));
        syncMobileLayout(Boolean(mobileQuery?.matches));
        scheduleActionReveal.touchId = null;
        resetScheduleActionPull();
        if (desktopQuery?.matches) {
            closeSidebar({ restoreFocus: false });
            showScheduleActions();
        } else {
            hideScheduleActions(false);
        }
    };
    resources.listen(desktopQuery, 'change', syncWorkspace);
    resources.listen(mobileQuery, 'change', syncWorkspace);
    syncWorkspace();
    resources.listen(page, 'touchstart', handleScheduleActionTouchStart, { passive: true });
    resources.listen(page, 'touchmove', handleScheduleActionTouchMove, { passive: false });
    resources.listen(page, 'touchend', handleScheduleActionTouchEnd);
    resources.listen(page, 'touchcancel', handleScheduleActionTouchEnd);
    resources.listen(page, 'wheel', handleScheduleActionWheel, { passive: false });
    resources.listen(document, 'keydown', handleScheduleActionKeyDown);
}

