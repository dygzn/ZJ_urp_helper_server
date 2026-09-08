const app = getApp();
const auth = require('../../utils/auth.js');
const request = require('../../utils/request.js');

Page({
  data: {
    username: '',
    password: '',
    submitting: false,
    status: '',
    statusType: '',
  },

  onLoad() {
    auth.ensureSession().catch(error => {
      this.setStatus(error.message || '微信登录失败，请重试', 'status-error');
    });
  },

  onUsernameInput(event) {
    this.setData({ username: event.detail.value });
  },

  onPasswordInput(event) {
    this.setData({ password: event.detail.value });
  },

  setStatus(status, statusType) {
    this.setData({ status, statusType });
  },

  submit() {
    const username = String(this.data.username || '').trim();
    const password = String(this.data.password || '');
    if (!username || !password) {
      this.setStatus('请输入教务账号和密码', 'status-error');
      return;
    }

    this.setData({ submitting: true, status: '', statusType: '' });
    request({
      path: '/api/wechat/bind',
      method: 'POST',
      data: { username, password },
    })
      .then(data => {
        app.updateBinding(data);
        this.setData({ password: '', submitting: false });
        wx.showToast({ title: '绑定成功', icon: 'success' });
        setTimeout(() => {
          wx.switchTab({ url: '/pages/home/index' });
        }, 450);
      })
      .catch(error => {
        this.setData({ password: '', submitting: false });
        this.setStatus(error.message || '绑定失败，请重试', 'status-error');
      });
  },
});
