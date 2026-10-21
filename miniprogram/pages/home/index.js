const app = getApp();
const auth = require('../../utils/auth.js');
const request = require('../../utils/request.js');

Page({
  data: {
    loading: true,
    bound: false,
    username: '',
    urgent: null,
    urgentLoading: false,
    urgentError: '',
    errorMessage: '',
  },

  onShow() {
    app.watchAccountPage(this);
    this.loadHome();
  },

  onUnload() {
    app.forgetAccountPage(this);
  },

  clearAccountData() {
    this.hasLoaded = false;
    this.setData({ loading: false, bound: false, errorMessage: '', username: '', urgent: null, urgentLoading: false, urgentError: '' });
  },

  onPullDownRefresh() {
    this.loadHome().finally(() => wx.stopPullDownRefresh());
  },

  loadHome() {
    const context = app.beginAccountRequest(this);
    this.setData({ loading: true, errorMessage: '', urgentError: '' });
    return auth
      .ensureSession()
      .then(() => app.isCurrentAccountRequest(this, context)
        ? request({ path: '/api/wechat/account' }) : null)
      .then(binding => {
        if (!app.acceptAccountResponse(this, context, binding)) return null;
        this.setData({
          bound: Boolean(binding.bound),
          username: binding.username || '',
          loading: false,
        });
        if (binding.bound) return this.loadUrgent();
        this.setData({ urgent: null, urgentLoading: false });
        return null;
      })
      .catch(error => {
        if (!app.isCurrentAccountRequest(this, context)) return null;
        wx.showToast({ title: (error.message || '读取首页信息失败，请重试').slice(0, 20), icon: 'none' });
        this.setData({
          loading: false,
          errorMessage: error.message || '读取首页信息失败，请重试',
        });
        return null;
      });
  },

  loadUrgent() {
    const context = app.beginAccountRequest(this);
    this.setData({ urgentLoading: true, urgentError: '' });
    return request({ path: '/api/wechat/urgent_event' })
      .then(data => {
        if (!app.isCurrentAccountRequest(this, context)) return null;
        this.setData({ urgent: data.event || null, urgentLoading: false });
        return data;
      })
      .catch(error => {
        if (!app.isCurrentAccountRequest(this, context)) return null;
        wx.showToast({ title: (error.message || '紧急事项读取失败').slice(0, 20), icon: 'none' });
        this.setData({
          urgentLoading: false,
          urgentError: error.message || '紧急事项读取失败',
        });
        return null;
      });
  },

  goBind() {
    app.navigateToBind();
  },

  openSchedule() {
    wx.switchTab({ url: '/pages/schedule/index' });
  },

  openGrades() {
    wx.switchTab({ url: '/pages/grades/index' });
  },

  openExams() {
    wx.switchTab({ url: '/pages/exams/index' });
  },

  openAccount() {
    wx.switchTab({ url: '/pages/account/index' });
  },
});
