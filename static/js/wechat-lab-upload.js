(function () {
  'use strict';
  // The fragment never travels in an HTTP request; remove it before loading the SDK.
  const ticket = new URLSearchParams(location.hash.slice(1)).get('ticket') || '';
  history.replaceState(null, '', location.pathname);
  const input = document.getElementById('pdf');
  const submit = document.getElementById('submit');
  const form = document.getElementById('upload-form');
  const info = document.getElementById('file-info');
  const context = document.getElementById('context');
  const message = document.getElementById('message');
  const progress = document.getElementById('progress');
  let ready = false;
  let sent = false;
  let busy = false;
  const MAX_PDF = 20 * 1024 * 1024;

  function show(text, error) {
    message.textContent = text;
    message.dataset.error = error ? 'true' : 'false';
  }

  document.getElementById('back').addEventListener('click', function () {
    if (window.wx && wx.miniProgram && wx.miniProgram.navigateBack) {
      wx.miniProgram.navigateBack({ delta: 1 });
    } else {
      history.back();
    }
  });

  function terminal(text, error) {
    busy = false;
    sent = true;
    input.disabled = true;
    submit.disabled = true;
    submit.textContent = '请返回核对状态';
    progress.hidden = true;
    show(text, error);
  }

  input.addEventListener('change', function () {
    const file = input.files && input.files[0];
    submit.disabled = true;
    if (!file) {
      info.textContent = '尚未选择文件';
      return;
    }
    info.textContent = file.name + ' · ' + (file.size / (1024 * 1024)).toFixed(2) + 'MB';
    if (!/\.pdf$/i.test(file.name) || file.size < 8 || file.size > MAX_PDF) {
      show('请选择 20MB 以内的 PDF 文件。', true);
      return;
    }
    show('已选择文件，点击“上传报告”后发送。');
    submit.disabled = !ready || sent || busy;
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    const file = input.files && input.files[0];
    if (!ready || busy || sent || !file || submit.disabled) return;
    busy = true;
    sent = true;
    input.disabled = true;
    submit.disabled = true;
    submit.textContent = '正在上传…';
    progress.hidden = false;
    show('正在发送文件，请保持页面打开。');
    const data = new FormData();
    data.append('file', file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/wechat/lab/local-upload');
    xhr.timeout = 90000;
    xhr.setRequestHeader('Authorization', 'LabUpload ' + ticket);
    xhr.upload.addEventListener('progress', function (event) {
      if (event.lengthComputable) progress.value = Math.round(event.loaded * 100 / event.total);
    });
    xhr.addEventListener('load', function () {
      let result;
      try { result = JSON.parse(xhr.responseText); } catch (_) {
        terminal('未能确认上传结果，请先返回刷新任务或到实验站核对，勿重复提交。', true);
        return;
      }
      if (result.success) {
        terminal((result.data && result.data.message) || result.message || '文件已发送，请返回核对提交状态。');
      } else if (result.retryable === true) {
        busy = false;
        sent = false;
        input.disabled = false;
        input.value = '';
        progress.hidden = true;
        submit.textContent = '上传报告';
        info.textContent = '尚未选择文件';
        show(result.message || '文件校验失败，请重新选择 PDF。', true);
      } else {
        terminal((result.message || '未能确认上传结果。') + ' 请先返回核对状态，勿重复提交。', true);
      }
    });
    const unknown = function () {
      terminal('连接中断或等待超时，上传结果待核实。请先返回刷新任务或到实验站核对，勿重复提交。', true);
    };
    xhr.addEventListener('error', unknown);
    xhr.addEventListener('timeout', unknown);
    xhr.addEventListener('abort', unknown);
    xhr.send(data);
  });

  if (!ticket) {
    context.textContent = '上传凭证不可用';
    show('请返回小程序，重新点击“从本地文件选择”。', true);
    return;
  }
  fetch('/api/wechat/lab/local-ticket-info', {
    headers: { Authorization: 'LabUpload ' + ticket }, cache: 'no-store', credentials: 'omit'
  }).then(function (response) { return response.json(); }).then(function (result) {
    if (!result.success) throw new Error(result.message || '上传凭证不可用');
    context.textContent = result.data.title + ' · ' + result.data.kind_label + ' · ' + result.data.semester;
    ready = true;
    input.disabled = false;
    show('请选择文件并核对报告类型。');
  }).catch(function (error) {
    context.textContent = '无法读取报告信息';
    show(error.message + '，请返回小程序重新打开。', true);
  });
  const sdk = document.createElement('script');
  sdk.src = 'https://res.wx.qq.com/open/js/jweixin-1.6.0.js';
  sdk.referrerPolicy = 'no-referrer';
  document.head.appendChild(sdk);
})();
