App({
  globalData: {
    authReady: false,
    bound: false,
    username: '',
    semesterStart: '',
  },

  onLaunch() {
    this.globalData.launchedAt = Date.now();
  },
});
