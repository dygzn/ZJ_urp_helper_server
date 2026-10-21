const auth = require('./utils/auth.js');
const request = require('./utils/request.js');

App({
  globalData: {
    authReady: false,
    bindingRevision: 0,
    bound: false,
    username: '',
    semesterStart: '',
    authError: '',
  },

  onLaunch() {
    this.globalData.launchedAt = Date.now();
    this.bootstrapPromise = this.bootstrapSession();
  },

  bootstrapSession() {
    if (this.bootstrapPromise) return this.bootstrapPromise;
    const revision = this.globalData.bindingRevision;
    this.bootstrapPromise = auth
      .ensureSession()
      .then(() => revision === this.globalData.bindingRevision
        ? request({ path: '/api/wechat/account' }) : null)
      .then(data => {
        if (!data || revision !== this.globalData.bindingRevision) return null;
        this.updateBinding(data);
        this.globalData.authReady = true;
        this.globalData.authError = '';
        return data;
      })
      .catch(error => {
        if (revision !== this.globalData.bindingRevision) return null;
        auth.clearSession();
        this.updateBinding({ bound: false });
        this.globalData.authReady = true;
        this.globalData.authError = error.message || '微信登录失败，请重试';
        return null;
      });
    return this.bootstrapPromise;
  },

  updateBinding(data) {
    const bound = Boolean(data && data.bound);
    const username = bound ? (data.username || '') : '';
    const changed = bound !== this.globalData.bound || username !== this.globalData.username;
    this.globalData.bound = bound;
    this.globalData.username = username;
    if (changed) {
      this.globalData.bindingRevision += 1;
      this.globalData.semesterStart = '';
      for (const page of this.accountPages || []) {
        page._bindingRevision = this.globalData.bindingRevision;
        page.clearAccountData();
      }
    }
  },

  watchAccountPage(page) {
    if (!this.accountPages) this.accountPages = new Set();
    this.accountPages.add(page);
    if (page._bindingRevision !== this.globalData.bindingRevision) {
      page._bindingRevision = this.globalData.bindingRevision;
      page.clearAccountData();
    }
  },

  forgetAccountPage(page) {
    if (this.accountPages) this.accountPages.delete(page);
    page._accountRequestId = (page._accountRequestId || 0) + 1;
  },

  beginAccountRequest(page) {
    this.watchAccountPage(page);
    page._accountRequestId = (page._accountRequestId || 0) + 1;
    return { revision: this.globalData.bindingRevision, id: page._accountRequestId };
  },

  isCurrentAccountRequest(page, context) {
    return context.revision === this.globalData.bindingRevision && context.id === page._accountRequestId;
  },

  acceptAccountResponse(page, context, binding) {
    if (!binding || context.id !== page._accountRequestId) return false;
    if (context.revision !== this.globalData.bindingRevision) {
      // 启动查询可能已确认同一身份；重新发起读取，不应用过期响应。
      if (Boolean(binding.bound) === this.globalData.bound &&
          (binding.username || '') === this.globalData.username) page.onShow();
      return false;
    }
    this.updateBinding(binding);
    context.revision = this.globalData.bindingRevision;
    return true;
  },

  navigateToBind() {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
    if (!pages.length) return false;
    wx.navigateTo({ url: '/pages/bind/index' });
    return true;
  },
});
