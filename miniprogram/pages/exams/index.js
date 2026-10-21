const app = getApp();
const auth = require('../../utils/auth.js');
const request = require('../../utils/request.js');
const format = require('../../utils/format.js');

Page({
  data: {
    loading: true,
    updating: false,
    bound: false,
    exams: [],
    errorMessage: '',
  },

  onShow() {
    app.watchAccountPage(this);
    if (!this.hasLoaded) return this.loadExams();
  },

  onUnload() {
    app.forgetAccountPage(this);
  },

  clearAccountData() {
    this.hasLoaded = false;
    this.setData({ loading: false, bound: false, errorMessage: '', updating: false, exams: [] });
  },

  onPullDownRefresh() {
    this.refreshExams().finally(() => wx.stopPullDownRefresh());
  },

  loadExams() {
    const context = app.beginAccountRequest(this);
    this.setData({ loading: true, errorMessage: '' });
    return auth
      .ensureSession()
      .then(() => app.isCurrentAccountRequest(this, context)
        ? request({ path: '/api/wechat/account' }) : null)
      .then(binding => {
        if (!app.acceptAccountResponse(this, context, binding)) return null;
        if (!binding.bound) {
          this.setData({ loading: false, bound: false, exams: [] });
          return null;
        }
        this.setData({ bound: true, loading: true });
        return request({ path: '/api/wechat/exams' });
      })
      .then(response => {
        if (!response || !app.isCurrentAccountRequest(this, context)) return null;
        this.hasLoaded = true;
        this.setData({
          loading: false,
          exams: (response.exams || []).map(item => {
            const exam = format.formatExam(item);
            return Object.assign(exam, {
              displayTime: exam.time || '--',
              displayLocation: exam.location || '',
              displaySeat: exam.seat || '',
            });
          }),
        });
        return response;
      })
      .catch(error => {
        if (!app.isCurrentAccountRequest(this, context)) return null;
        wx.showToast({ title: (error.message || '读取考试安排失败，请重试').slice(0, 20), icon: 'none' });
        this.setData({
          loading: false,
          errorMessage: error.message || '读取考试安排失败，请重试',
        });
        return null;
      });
  },

  refreshExams() {
    if (this.data.updating) return Promise.resolve(null);
    const revision = app.globalData.bindingRevision;
    this.setData({ updating: true, errorMessage: '' });
    return request({ path: '/api/wechat/update_exams', method: 'POST', data: {} })
      .then(() => revision === app.globalData.bindingRevision ? this.loadExams() : null)
      .catch(error => {
        if (revision !== app.globalData.bindingRevision) return null;
        wx.showToast({ title: (error.message || '更新考试安排失败，请重试').slice(0, 20), icon: 'none' });
        this.setData({ errorMessage: error.message || '更新考试安排失败，请重试' });
        return null;
      })
      .finally(() => {
        if (revision === app.globalData.bindingRevision) this.setData({ updating: false });
      });
  },

  goBind() {
    app.navigateToBind();
  },
});
