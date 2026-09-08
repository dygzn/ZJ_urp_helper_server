const config = require('./config.js');

function getToken() {
  return wx.getStorageSync(config.tokenStorageKey) || '';
}

function clearSession() {
  wx.removeStorageSync(config.tokenStorageKey);
}

function login() {
  return new Promise((resolve, reject) => {
    wx.login({
      success(loginResult) {
        if (!loginResult || !loginResult.code) {
          reject({ statusCode: 0, message: '微信登录凭证获取失败，请重试' });
          return;
        }

        wx.request({
          url: `${config.apiBaseUrl}/api/wechat/session`,
          method: 'POST',
          data: { code: loginResult.code },
          header: { 'Content-Type': 'application/json' },
          timeout: config.requestTimeout,
          success(response) {
            const payload = response.data || {};
            if (
              response.statusCode >= 200 &&
              response.statusCode < 300 &&
              payload.success &&
              payload.token
            ) {
              wx.setStorageSync(config.tokenStorageKey, payload.token);
              resolve(payload);
              return;
            }
            reject({
              statusCode: response.statusCode,
              message: payload.message || '微信登录失败，请稍后重试',
              data: payload,
            });
          },
          fail(error) {
            reject({
              statusCode: 0,
              message: '网络连接失败，请检查网络后重试',
              data: null,
              originalError: error,
            });
          },
        });
      },
      fail(error) {
        reject({
          statusCode: 0,
          message: '微信登录调用失败，请重试',
          data: null,
          originalError: error,
        });
      },
    });
  });
}

function ensureSession() {
  const token = getToken();
  if (token) return Promise.resolve({ success: true, token, stored: true });
  return login();
}

module.exports = {
  getToken,
  clearSession,
  login,
  ensureSession,
};
