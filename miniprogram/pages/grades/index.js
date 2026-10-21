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
    if (!this.hasLoaded) this.loadGrades();
  },

  onPullDownRefresh() {
    this.loadGrades().finally(() => wx.stopPullDownRefresh());
  },

  loadGrades() {
    this.setData({ loading: true, errorMessage: '' });
    return auth
      .ensureSession()
      .then(() => request({ path: '/api/wechat/account' }))
      .then(binding => {
        app.updateBinding(binding);
        if (!binding.bound) {
          this.setData({ loading: false, bound: false });
          return null;
        }
        this.setData({ bound: true });
        return Promise.all([
          request({ path: '/api/wechat/grades/latest_summary' }),
          request({ path: '/api/wechat/grades/current' }),
        ]);
      })
      .then(result => {
        if (!result) return null;
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
