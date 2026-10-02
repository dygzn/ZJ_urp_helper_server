import { pageResources } from './lifecycle.js';
const resources = pageResources('service-status');

export function mountService() {
    resources.listen(document, 'click', handleServiceClick);
    return loadServiceStatus();
}

export function unmountService() {
    resources.dispose();
    setServiceContactPopoverOpen(false);
}

export function setServiceContactPopoverOpen(isOpen) {
    const trigger = document.getElementById('service-contact-trigger');
    const popover = document.getElementById('service-contact-popover');
    if (!trigger || !popover) return;

    trigger.setAttribute('aria-expanded', String(isOpen));
    popover.hidden = !isOpen;
}

export async function loadServiceStatus() {
    const operation = resources.capture();
    const content = document.getElementById('service-status-content');
    if (!content) return;

    content.innerHTML = '<div class="loading">加载中...</div>';

    try {
        const response = await operation.wait(resources.fetch('/api/service-status'));
        const result = await operation.wait(response.json());
        if (!response.ok || !result.success) {
            throw new Error(result.message || '状态加载失败');
        }

        const view = ServiceStatusUI.buildServiceStatusViewModel(result.data);
        const statusText = document.createElement('div');
        statusText.className = 'service-status-text';
        statusText.textContent = view.statusText;

        const availability = document.createElement('div');
        availability.className = `service-availability ${view.acceptingOrders ? 'is-accepting' : 'is-unavailable'}`;
        const availabilityDot = document.createElement('span');
        availabilityDot.className = 'service-availability-dot';
        const availabilityText = document.createElement('span');
        availabilityText.textContent = view.availabilityText;
        availability.append(availabilityDot, availabilityText);

        const updated = document.createElement('div');
        updated.className = 'service-status-updated';
        updated.textContent = view.updatedText;

        content.replaceChildren(statusText, availability, updated);
    } catch (error) {
        if (error?.name === 'AbortError') return;
        console.error('加载接单状态失败:', error);
        content.innerHTML = '';
        const message = document.createElement('p');
        message.className = 'service-status-error';
        message.textContent = '状态加载失败，请稍后重试';
        const retry = document.createElement('button');
        retry.className = 'btn-secondary';
        retry.type = 'button';
        retry.textContent = '重新加载';
        retry.addEventListener('click', loadServiceStatus);
        content.append(message, retry);
    }
}

export async function handleServiceClick(event) {
    const operation = resources.capture();
    const element = event.target instanceof Element ? event.target : null;
    const trigger = element?.closest('#service-contact-trigger');
    if (trigger) {
        const isOpen = trigger.getAttribute('aria-expanded') === 'true';
        setServiceContactPopoverOpen(
            ServiceStatusUI.nextContactPopoverState(isOpen, 'toggle'),
        );
        return;
    }

    const option = element?.closest('.service-contact-option[data-copy-text]');
    if (option) {
        const feedback = option.querySelector('[data-copy-feedback]');
        const originalText = feedback?.textContent || '';
        setServiceContactPopoverOpen(
            ServiceStatusUI.nextContactPopoverState(true, 'select'),
        );
        const copied = await operation.wait(ServiceStatusUI.copyText(option.dataset.copyText));

        if (!copied) {
            console.warn('联系账号复制失败');
            return;
        }

        if (feedback) {
            feedback.textContent = '已复制';
            resources.setTimeout(() => {
                if (feedback.isConnected) feedback.textContent = originalText;
            }, 1500);
        }
        return;
    }

    const control = document.querySelector('.service-contact-control');
    const popover = document.getElementById('service-contact-popover');
    if (control && popover && !popover.hidden && !control.contains(element)) {
        setServiceContactPopoverOpen(
            ServiceStatusUI.nextContactPopoverState(true, 'outside-click'),
        );
    }
}
