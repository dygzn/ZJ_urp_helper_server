const config = require('./config.js');

function readToken() {
  return wx.getStorageSync(config.tokenStorageKey) || '';
}

function clearToken() {
  wx.removeStorageSync(config.tokenStorageKey);
}

function request({ path, method = 'GET', data = {}, header = {} }) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, header);
    const token = readToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    wx.request({
      url: `${config.apiBaseUrl}${path}`,
      method,
      data,
      header: headers,
      timeout: config.requestTimeout,
      success(response) {
        const payload = response.data || {};
        const sessionExpired =
          response.statusCode === 401 || payload.code === 'WECHAT_SESSION_REQUIRED';
        if (sessionExpired) clearToken();

        if (
          response.statusCode >= 200 &&
          response.statusCode < 300 &&
          payload.success !== false
        ) {
          resolve(payload);
          return;
        }

        reject({
          statusCode: response.statusCode,
          message: payload.message || '请求失败，请稍后重试',
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
  });
}

module.exports = request;
