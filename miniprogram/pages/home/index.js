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
    this.loadHome();
  },

  onPullDownRefresh() {
    this.loadHome().finally(() => wx.stopPullDownRefresh());
  },

  loadHome() {
    this.setData({ loading: true, errorMessage: '', urgentError: '' });
    return auth
      .ensureSession()
      .then(() => request({ path: '/api/wechat/account' }))
      .then(binding => {
        app.updateBinding(binding);
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
        wx.showToast({ title: (error.message || '读取首页信息失败，请重试').slice(0, 20), icon: 'none' });
        this.setData({
          loading: false,
          errorMessage: error.message || '读取首页信息失败，请重试',
        });
        return null;
      });
  },

  loadUrgent() {
    this.setData({ urgentLoading: true, urgentError: '' });
    return request({ path: '/api/wechat/urgent_event' })
      .then(data => {
        this.setData({ urgent: data.event || null, urgentLoading: false });
        return data;
      })
      .catch(error => {
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
