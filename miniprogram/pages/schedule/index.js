const app = getApp();
const auth = require('../../utils/auth.js');
const request = require('../../utils/request.js');
const format = require('../../utils/format.js');

Page({
  data: {
    loading: true,
    updating: false,
    bound: false,
    week: 1,
    semesterStart: '',
    groups: [],
    errorMessage: '',
  },

  onShow() {
    if (!this.hasLoaded) this.loadInitialSchedule();
  },

  onPullDownRefresh() {
    this.refreshSchedule().finally(() => wx.stopPullDownRefresh());
  },

  loadInitialSchedule() {
    this.setData({ loading: true, errorMessage: '' });
    return auth
      .ensureSession()
      .then(() => request({ path: '/api/check_bind' }))
      .then(binding => {
        app.updateBinding(binding);
        if (!binding.bound) {
          this.setData({ loading: false, bound: false, groups: [] });
          return null;
        }
        this.setData({ bound: true });
        return request({ path: '/api/schedule' });
      })
      .then(response => {
        if (!response) return null;
        const scheduleData = response.data || {};
        const semesterStart = scheduleData.semester_start || '';
        const week = format.getCurrentWeek(semesterStart);
        app.globalData.semesterStart = semesterStart;
        this.hasLoaded = true;
        this.setData({
          loading: false,
          semesterStart,
          week,
          groups: format.groupSchedule({
            [String(week)]: (scheduleData.schedule || {})[String(week)] || [],
          }),
        });
        return response;
      })
      .catch(error => {
        wx.showToast({ title: (error.message || '读取课表失败，请重试').slice(0, 20), icon: 'none' });
        this.setData({
          loading: false,
          errorMessage: error.message || '读取课表失败，请重试',
        });
        return null;
      });
  },

  loadWeek(week) {
    const targetWeek = Math.max(1, Number(week) || 1);
    this.setData({ loading: true, errorMessage: '', week: targetWeek });
    return request({ path: '/api/schedule', data: { week: targetWeek } })
      .then(response => {
        const scheduleData = response.data || {};
        this.setData({
          loading: false,
          groups: format.groupSchedule(scheduleData.schedule || {}),
        });
        return response;
      })
      .catch(error => {
        wx.showToast({ title: (error.message || '读取课表失败，请重试').slice(0, 20), icon: 'none' });
        this.setData({
          loading: false,
          errorMessage: error.message || '读取课表失败，请重试',
          groups: [],
        });
        return null;
      });
  },

  previousWeek() {
    if (this.data.week <= 1 || this.data.loading) return;
    this.loadWeek(this.data.week - 1);
  },

  nextWeek() {
    if (this.data.loading) return;
    this.loadWeek(this.data.week + 1);
  },

  refreshSchedule() {
    if (this.data.updating) return Promise.resolve(null);
    this.setData({ updating: true, errorMessage: '' });
    return request({ path: '/api/update_schedule', method: 'POST', data: {} })
      .then(() => this.loadInitialSchedule())
      .catch(error => {
        wx.showToast({ title: (error.message || '更新课表失败，请重试').slice(0, 20), icon: 'none' });
        this.setData({
          errorMessage: error.message || '更新课表失败，请重试',
        });
        return null;
      })
      .finally(() => this.setData({ updating: false }));
  },

  goBind() {
    app.navigateToBind();
  },
});
