const app = getApp();
const auth = require('../../utils/auth.js');
const request = require('../../utils/request.js');

Page({
  data: {
    loading: true,
    bound: false,
    username: '',
    message: '',
    errorMessage: '',
    rebindLoading: false,
  },

  onShow() {
    app.watchAccountPage(this);
    this.loadBinding();
  },

  onUnload() {
    app.forgetAccountPage(this);
  },

  clearAccountData() {
    this.hasLoaded = false;
    this.setData({ loading: false, bound: false, errorMessage: '', username: '', message: '', rebindLoading: false });
  },

  onPullDownRefresh() {
    this.loadBinding().finally(() => wx.stopPullDownRefresh());
  },

  loadBinding() {
    const context = app.beginAccountRequest(this);
    this.setData({ loading: true, errorMessage: '' });
    return auth
      .ensureSession()
      .then(() => app.isCurrentAccountRequest(this, context)
        ? request({ path: '/api/wechat/account' }) : null)
      .then(data => {
        if (!app.acceptAccountResponse(this, context, data)) return null;
        this.setData({
          loading: false,
          bound: Boolean(data.bound),
          username: data.username || '',
          message: '',
        });
        return data;
      })
      .catch(error => {
        if (!app.isCurrentAccountRequest(this, context)) return null;
        wx.showToast({ title: (error.message || '读取绑定状态失败，请重试').slice(0, 20), icon: 'none' });
        this.setData({
          loading: false,
          errorMessage: error.message || '读取绑定状态失败，请重试',
        });
        return null;
      });
  },

  goBind() {
    wx.navigateTo({ url: '/pages/bind/index' });
  },

  rebind() {
    wx.showModal({
      title: '重新绑定账号',
      content: '解绑后需要重新输入新的教务账号密码，确定继续吗？',
      confirmText: '继续',
      confirmColor: '#b54747',
      success: result => {
        if (!result.confirm) return;
        this.setData({ rebindLoading: true, message: '' });
        request({ path: '/api/wechat/binding', method: 'DELETE', data: {} })
          .then(data => {
            app.updateBinding({ bound: false, username: '' });
            this.setData({ rebindLoading: false });
            wx.showToast({ title: data.message || '已解绑', icon: 'success' });
            setTimeout(() => {
              wx.navigateTo({ url: '/pages/bind/index' });
            }, 450);
          })
          .catch(error => {
            wx.showToast({ title: (error.message || '重新绑定失败，请重试').slice(0, 20), icon: 'none' });
            this.setData({
              rebindLoading: false,
              message: error.message || '重新绑定失败，请重试',
            });
          });
      },
    });
  },
});
