const auth = require('./utils/auth.js');
const request = require('./utils/request.js');

App({
  globalData: {
    authReady: false,
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
    this.bootstrapPromise = auth
      .ensureSession()
      .then(() => request({ path: '/api/check_bind' }))
      .then(data => {
        this.globalData.authReady = true;
        this.globalData.authError = '';
        this.globalData.bound = Boolean(data.bound);
        this.globalData.username = data.username || '';
        return data;
      })
      .catch(error => {
        auth.clearSession();
        this.globalData.authReady = true;
        this.globalData.bound = false;
        this.globalData.username = '';
        this.globalData.authError = error.message || '微信登录失败，请重试';
        return null;
      });
    return this.bootstrapPromise;
  },

  updateBinding(data) {
    this.globalData.bound = Boolean(data && data.bound);
    this.globalData.username = (data && data.username) || '';
  },

  navigateToBind() {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
    if (!pages.length) return false;
    wx.navigateTo({ url: '/pages/bind/index' });
    return true;
  },
});
