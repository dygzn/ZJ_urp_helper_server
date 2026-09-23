let wechatPage = 1;
let wechatRequest = 0;
async function loadWechatBindings(page = wechatPage) {
    const requestId = ++wechatRequest;
    const container = document.getElementById('wechat-bindings-list');
    container.textContent = '正在加载…';
    const username = document.getElementById('wechat-username-filter').value.trim();
    try {
        const response = await fetch(`/api/admin/wechat/bindings?page=${Math.max(1, page)}&username=${encodeURIComponent(username)}`, {headers: {'X-Admin-Key': adminKey}});
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.message || '加载失败');
        if (requestId !== wechatRequest) return;
        wechatPage = result.page;
        container.replaceChildren();
        if (!result.data.length) container.textContent = '暂无微信绑定';
        result.data.forEach(binding => {
            const row = document.createElement('div');
            row.className = 'wechat-binding-card';
            const info = document.createElement('div');
            info.className = 'wechat-binding-info';
            const account = document.createElement('strong');
            account.textContent = binding.username;
            const time = document.createElement('span');
            time.textContent = `绑定时间 ${binding.bind_time || '未知'}`;
            info.append(account, time);
            const button = document.createElement('button');
            button.className = 'btn-danger';
            button.type = 'button';
            button.textContent = '解除微信绑定';
            button.addEventListener('click', async () => {
                if (!window.confirm(`确认解除学号 ${binding.username} 的微信绑定？网页绑定和会员权益不受影响。`)) return;
                button.disabled = true;
                try {
                    const res = await fetch('/api/admin/wechat/bindings/' + encodeURIComponent(binding.openid), {method:'DELETE', headers:{'X-Admin-Key':adminKey}});
                    const data = await res.json();
                    if (!res.ok || !data.success) throw new Error(data.message || '解绑失败');
                    await loadWechatBindings();
                } catch (error) { showAdminToast(error.message, 'error'); button.disabled = false; }
            });
            row.append(info, button);
            container.append(row);
        });
        document.getElementById('wechat-page').textContent = `第 ${wechatPage} 页 · 共 ${result.total} 个绑定`;
        document.getElementById('wechat-prev').disabled = wechatPage <= 1;
        document.getElementById('wechat-next').disabled = wechatPage * 50 >= result.total;
    } catch (error) { if (requestId === wechatRequest) container.textContent = error.message; }
}
