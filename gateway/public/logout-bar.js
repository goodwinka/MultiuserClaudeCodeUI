(function () {
  function createLogoutBar() {
    var bar = document.createElement('div');
    bar.id = '__gw_logout_bar';
    bar.style.cssText = [
      'position:fixed',
      'top:0',
      'right:0',
      'z-index:2147483647',
      'display:flex',
      'align-items:center',
      'gap:8px',
      'padding:5px 10px',
      'background:rgba(22,27,34,0.92)',
      'border-bottom-left-radius:8px',
      'border:1px solid #30363d',
      'border-top:none',
      'border-right:none',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'font-size:12px',
      'color:#8b949e',
      'backdrop-filter:blur(4px)',
      'box-shadow:0 2px 8px rgba(0,0,0,0.4)',
    ].join(';');

    var userSpan = document.createElement('span');
    userSpan.id = '__gw_username';
    userSpan.textContent = '';
    bar.appendChild(userSpan);

    var btn = document.createElement('button');
    btn.textContent = 'Выйти';
    btn.style.cssText = [
      'background:#21262d',
      'color:#cdd9e5',
      'border:1px solid #444c56',
      'border-radius:5px',
      'padding:3px 10px',
      'font-size:12px',
      'cursor:pointer',
      'font-family:inherit',
      'transition:background 0.15s',
    ].join(';');

    btn.addEventListener('mouseenter', function () {
      btn.style.background = '#e53e3e';
      btn.style.borderColor = '#e53e3e';
      btn.style.color = '#fff';
    });
    btn.addEventListener('mouseleave', function () {
      btn.style.background = '#21262d';
      btn.style.borderColor = '#444c56';
      btn.style.color = '#cdd9e5';
    });

    btn.addEventListener('click', function () {
      var form = document.createElement('form');
      form.method = 'POST';
      form.action = '/__gateway/auth/logout';
      document.body.appendChild(form);
      form.submit();
    });

    bar.appendChild(btn);
    document.body.appendChild(bar);

    // Fetch current username
    fetch('/__gateway/api/me')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.username) {
          userSpan.textContent = data.username;
        }
      })
      .catch(function () {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createLogoutBar);
  } else {
    createLogoutBar();
  }
})();
