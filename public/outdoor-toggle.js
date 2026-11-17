'use strict';
/* 露天模式切换：页面加载即恢复上次选择，点击切换并记忆。
   display 与 science 两页共用；localStorage 键统一，切一次两页都生效。 */
(function () {
  var KEY = 'outdoorMode';
  function apply(on) {
    document.body.classList.toggle('outdoor', !!on);
    var btn = document.getElementById('toggleOutdoor');
    if (btn) {
      btn.classList.toggle('on', !!on);
      btn.textContent = on ? '☀ 室内' : '☀ 露天';
      btn.title = on ? '当前露天高对比，点击切回室内影院' : '露天强光下切换高对比配色';
    }
  }
  // 尽早应用，避免深色闪烁。URL 带 ?outdoor=1/0 可强制指定，便于做快捷方式/验证
  var saved = false;
  try { saved = localStorage.getItem(KEY) === '1'; } catch (e) {}
  var q = new URLSearchParams(location.search).get('outdoor');
  if (q === '1') saved = true;
  else if (q === '0') saved = false;
  apply(saved);

  function init() {
    var btn = document.getElementById('toggleOutdoor');
    if (btn) btn.addEventListener('click', function () {
      var on = !document.body.classList.contains('outdoor');
      try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (e) {}
      apply(on);
    });
    // 多标签/多屏同步：任一页切换后其它页实时跟随
    window.addEventListener('storage', function (e) {
      if (e.key === KEY) apply(e.newValue === '1');
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
