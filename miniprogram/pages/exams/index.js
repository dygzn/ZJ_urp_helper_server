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
    if (!this.hasLoaded) this.loadExams();
  },

  onPullDownRefresh() {
    this.refreshExams().finally(() => wx.stopPullDownRefresh());
  },

  loadExams() {
    this.setData({ loading: true, errorMessage: '' });
    return auth
      .ensureSession()
      .then(() => request({ path: '/api/wechat/account' }))
      .then(binding => {
        app.updateBinding(binding);
        if (!binding.bound) {
          this.setData({ loading: false, bound: false, exams: [] });
          return null;
        }
        this.setData({ bound: true });
        return request({ path: '/api/wechat/exams' });
      })
      .then(response => {
        if (!response) return null;
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
    this.setData({ updating: true, errorMessage: '' });
    return request({ path: '/api/wechat/update_exams', method: 'POST', data: {} })
      .then(() => this.loadExams())
      .catch(error => {
        wx.showToast({ title: (error.message || '更新考试安排失败，请重试').slice(0, 20), icon: 'none' });
        this.setData({ errorMessage: error.message || '更新考试安排失败，请重试' });
        return null;
      })
      .finally(() => this.setData({ updating: false }));
  },

  goBind() {
    app.navigateToBind();
  },
});
