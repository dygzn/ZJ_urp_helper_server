const app = getApp();
const auth = require('../../utils/auth.js');
const request = require('../../utils/request.js');
const format = require('../../utils/format.js');

Page({
  data: {
    loading: true,
    bound: false,
    errorMessage: '',
    summary: { semester: '', passed: [], failed: { current: [], past: [] } },
    currentGrades: [],
  },

  onShow() {
    app.watchAccountPage(this);
    if (!this.hasLoaded) return this.loadGrades();
  },

  onUnload() {
    app.forgetAccountPage(this);
  },

  clearAccountData() {
    this.hasLoaded = false;
    this.setData({ loading: false, bound: false, errorMessage: '', summary: { semester: '', passed: [], failed: { current: [], past: [] } }, currentGrades: [] });
  },

  onPullDownRefresh() {
    this.loadGrades().finally(() => wx.stopPullDownRefresh());
  },

  loadGrades() {
    const context = app.beginAccountRequest(this);
    this.setData({ loading: true, errorMessage: '' });
    return auth
      .ensureSession()
      .then(() => app.isCurrentAccountRequest(this, context)
        ? request({ path: '/api/wechat/account' }) : null)
      .then(binding => {
        if (!app.acceptAccountResponse(this, context, binding)) return null;
        if (!binding.bound) {
          this.setData({ loading: false, bound: false });
          return null;
        }
        this.setData({ bound: true, loading: true });
        return Promise.all([
          request({ path: '/api/wechat/grades/latest_summary' }),
          request({ path: '/api/wechat/grades/current' }),
        ]);
      })
      .then(result => {
        if (!result || !app.isCurrentAccountRequest(this, context)) return null;
        const [summaryData, currentData] = result;
        const summary = summaryData || {};
        const failed = summary.failed || {};
        this.hasLoaded = true;
        this.setData({
          loading: false,
          summary: {
            semester: summary.semester || '',
            passed: (summary.passed || []).map(item => ({
              ...item,
              displayScore: format.formatScore(item.score),
            })),
            failed: {
              current: failed.current || [],
              past: failed.past || [],
            },
          },
          currentGrades: (currentData.grades || []).map(item => ({
            ...item,
            displayScore: format.formatScore(item.score),
          })),
        });
        return result;
      })
      .catch(error => {
        if (!app.isCurrentAccountRequest(this, context)) return null;
        wx.showToast({ title: (error.message || '读取成绩失败，请重试').slice(0, 20), icon: 'none' });
        this.setData({
          loading: false,
          errorMessage: error.message || '读取成绩失败，请重试',
        });
        return null;
      });
  },

  goBind() {
    app.navigateToBind();
  },
});
