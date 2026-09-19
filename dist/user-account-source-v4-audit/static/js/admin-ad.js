const adFields = ['title', 'summary', 'image_url', 'detail_title', 'cover_url', 'body', 'contact', 'button_text', 'button_url'];
let advertisementLoaded = false;
function readAdvertisementForm() {
    const ad = { enabled: document.getElementById('ad-enabled').checked };
    adFields.forEach(key => { ad[key] = document.getElementById(`ad-${key}`).value.trim(); });
    return ad;
}
function previewAdvertisement() {
    const ad = readAdvertisementForm();
    const summary = document.getElementById('ad-preview-summary');
    const detail = document.getElementById('ad-preview-detail');
    summary.replaceChildren(); detail.replaceChildren();
    function add(parent, tag, value, className = '') {
        const node = document.createElement(tag); node.textContent = value; node.className = className; parent.append(node); return node;
    }
    function picture(parent, url) {
        try { if (!['http:', 'https:'].includes(new URL(url).protocol)) return; } catch (_) { return; }
        const img = document.createElement('img'); img.src = url; img.alt = ''; img.onerror = () => { img.hidden = true; }; parent.append(img);
    }
    add(summary, 'small', ad.enabled ? '推广 · 已勾选启用，保存后生效' : '广告已关闭 · 以下为草稿预览');
    if (ad.image_url) picture(summary, ad.image_url);
    add(summary, 'h4', ad.title || '活动标题'); add(summary, 'p', ad.summary || '一句话介绍活动');
    add(summary, 'span', '查看详情 →');
    if (ad.cover_url) picture(detail, ad.cover_url);
    add(detail, 'h2', ad.detail_title || ad.title || '活动标题');
    add(detail, 'p', ad.summary || '活动简介');
    add(detail, 'div', ad.body || '在左侧填写详细正文，支持换行。', 'campaign-prose');
    if (ad.contact) add(detail, 'p', `联系信息：${ad.contact}`);
    if (ad.button_url) add(detail, 'span', `${ad.button_text || '了解更多'} ↗`, 'campaign-button');
}
async function loadAdvertisement() {
    const status = document.getElementById('ad-config-status');
    const save = document.getElementById('ad-save');
    save.disabled = true; advertisementLoaded = false; status.textContent = '正在加载配置…';
    try {
        const response = await fetch('/api/admin/advertisement', {headers: {'X-Admin-Key': adminKey}});
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.message || '加载失败');
        adFields.forEach(key => { document.getElementById(`ad-${key}`).value = result.data[key] || ''; });
        document.getElementById('ad-enabled').checked = result.data.enabled;
        advertisementLoaded = true; save.disabled = false; status.textContent = ''; previewAdvertisement();
    } catch (error) { status.textContent = `加载失败：${error.message}，请重新进入广告管理重试。`; }
}
async function saveAdvertisement(event) {
    event.preventDefault(); if (!advertisementLoaded) return;
    const save = document.getElementById('ad-save'); const status = document.getElementById('ad-config-status');
    save.disabled = true; status.textContent = '正在保存…';
    try {
        const response = await fetch('/api/admin/advertisement', {method: 'PUT', headers: {'X-Admin-Key': adminKey, 'Content-Type': 'application/json'}, body: JSON.stringify(readAdvertisementForm())});
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.message || '保存失败');
        status.textContent = '已保存，刷新首页即可看到最新设置。';
    } catch (error) { status.textContent = `保存失败：${error.message}`; }
    finally { save.disabled = false; }
}
document.getElementById('ad-config-form')?.addEventListener('input', previewAdvertisement);
