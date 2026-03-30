(function () {
  // ── Shared button style helper ────────────────────────────────────────────
  function btnStyle(extra) {
    return [
      'background:#21262d',
      'color:#cdd9e5',
      'border:1px solid #444c56',
      'border-radius:5px',
      'padding:3px 10px',
      'font-size:12px',
      'cursor:pointer',
      'font-family:inherit',
      'transition:background 0.15s',
    ].concat(extra || []).join(';');
  }

  function hoverBlue(el) {
    el.addEventListener('mouseenter', function () {
      el.style.background = '#388bfd'; el.style.borderColor = '#388bfd'; el.style.color = '#fff';
    });
    el.addEventListener('mouseleave', function () {
      el.style.background = '#21262d'; el.style.borderColor = '#444c56'; el.style.color = '#cdd9e5';
    });
  }

  function hoverRed(el) {
    el.addEventListener('mouseenter', function () {
      el.style.background = '#e53e3e'; el.style.borderColor = '#e53e3e'; el.style.color = '#fff';
    });
    el.addEventListener('mouseleave', function () {
      el.style.background = '#21262d'; el.style.borderColor = '#444c56'; el.style.color = '#cdd9e5';
    });
  }

  // ── Settings modal ────────────────────────────────────────────────────────
  function openSettings() {
    if (document.getElementById('__gw_settings_overlay')) return;

    var overlay = document.createElement('div');
    overlay.id = '__gw_settings_overlay';
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483646',
      'background:rgba(0,0,0,0.6)',
      'display:flex', 'align-items:center', 'justify-content:center',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    ].join(';');

    var box = document.createElement('div');
    box.style.cssText = [
      'background:#161b22', 'color:#cdd9e5',
      'border:1px solid #30363d', 'border-radius:8px',
      'padding:24px', 'width:520px', 'max-width:calc(100vw - 32px)',
      'max-height:calc(100vh - 64px)', 'overflow-y:auto',
      'box-shadow:0 8px 32px rgba(0,0,0,0.6)',
    ].join(';');

    // ── Title ────────────────────────────────────────────────────────────────
    var title = document.createElement('h3');
    title.textContent = 'Настройки пользователя';
    title.style.cssText = 'margin:0 0 20px;font-size:16px;font-weight:600;color:#e6edf3;';
    box.appendChild(title);

    // ── Section helper ───────────────────────────────────────────────────────
    function section(label) {
      var h = document.createElement('div');
      h.textContent = label;
      h.style.cssText = 'font-size:12px;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 8px;';
      return h;
    }

    function inputStyle() {
      return [
        'background:#0d1117', 'color:#cdd9e5',
        'border:1px solid #30363d', 'border-radius:5px',
        'padding:5px 8px', 'font-size:13px',
        'font-family:inherit', 'width:100%', 'box-sizing:border-box',
        'outline:none',
      ].join(';');
    }

    function labeledInput(lbl, placeholder, value) {
      var wrap = document.createElement('div');
      wrap.style.cssText = 'margin-bottom:10px;';
      var l = document.createElement('label');
      l.textContent = lbl;
      l.style.cssText = 'display:block;font-size:12px;color:#8b949e;margin-bottom:4px;';
      wrap.appendChild(l);
      var inp = document.createElement('input');
      inp.type = 'text';
      inp.placeholder = placeholder;
      inp.value = value || '';
      inp.style.cssText = inputStyle();
      wrap.appendChild(inp);
      return { wrap: wrap, input: inp };
    }

    // ── Git identity ─────────────────────────────────────────────────────────
    box.appendChild(section('Git — имя и почта'));
    var gitName = labeledInput('Имя', 'Иван Иванов', '');
    var gitEmail = labeledInput('Email', 'ivan@example.com', '');
    box.appendChild(gitName.wrap);
    box.appendChild(gitEmail.wrap);

    // ── GitLab tokens ────────────────────────────────────────────────────────
    var glSep = document.createElement('div');
    glSep.style.cssText = 'border-top:1px solid #21262d;margin:16px 0;';
    box.appendChild(glSep);
    box.appendChild(section('GitLab — токены'));

    var glList = document.createElement('div');
    glList.style.marginBottom = '8px';
    box.appendChild(glList);

    function addGitlabRow(url, token) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;align-items:center;';

      var urlInp = document.createElement('input');
      urlInp.type = 'text';
      urlInp.placeholder = 'https://gitlab.example.com';
      urlInp.value = url || '';
      urlInp.style.cssText = inputStyle() + ';flex:2;width:auto;';

      var tokInp = document.createElement('input');
      tokInp.type = 'password';
      tokInp.placeholder = 'glpat-xxxxxxxx';
      tokInp.value = token || '';
      tokInp.style.cssText = inputStyle() + ';flex:2;width:auto;';

      var showBtn = document.createElement('button');
      showBtn.textContent = '👁';
      showBtn.title = 'Показать/скрыть токен';
      showBtn.style.cssText = [
        'background:#21262d', 'color:#8b949e', 'border:1px solid #444c56',
        'border-radius:5px', 'padding:3px 7px', 'font-size:12px',
        'cursor:pointer', 'flex-shrink:0',
      ].join(';');
      showBtn.addEventListener('click', function () {
        tokInp.type = tokInp.type === 'password' ? 'text' : 'password';
      });

      var rmBtn = document.createElement('button');
      rmBtn.textContent = '✕';
      rmBtn.title = 'Удалить';
      rmBtn.style.cssText = [
        'background:#21262d', 'color:#8b949e', 'border:1px solid #444c56',
        'border-radius:5px', 'padding:3px 8px', 'font-size:12px',
        'cursor:pointer', 'flex-shrink:0',
      ].join(';');
      rmBtn.addEventListener('click', function () { glList.removeChild(row); });

      row.appendChild(urlInp);
      row.appendChild(tokInp);
      row.appendChild(showBtn);
      row.appendChild(rmBtn);
      row._urlInp = urlInp;
      row._tokInp = tokInp;
      glList.appendChild(row);
    }

    var addGlBtn = document.createElement('button');
    addGlBtn.textContent = '+ Добавить GitLab';
    addGlBtn.style.cssText = btnStyle(['font-size:12px', 'padding:3px 10px']);
    hoverBlue(addGlBtn);
    addGlBtn.addEventListener('click', function () { addGitlabRow('', ''); });
    box.appendChild(addGlBtn);

    // ── URL redirects ────────────────────────────────────────────────────────
    var rdSep = document.createElement('div');
    rdSep.style.cssText = 'border-top:1px solid #21262d;margin:16px 0;';
    box.appendChild(rdSep);
    box.appendChild(section('Перенаправление URL (git)'));

    var hint = document.createElement('div');
    hint.textContent = 'Например: откуда → gitlab-internal.local, куда → localhost:8080';
    hint.style.cssText = 'font-size:11px;color:#6e7681;margin-bottom:8px;';
    box.appendChild(hint);

    var rdList = document.createElement('div');
    rdList.style.marginBottom = '8px';
    box.appendChild(rdList);

    function addRedirectRow(from, to) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;align-items:center;';

      var fromInp = document.createElement('input');
      fromInp.type = 'text';
      fromInp.placeholder = 'https://gitlab-internal.local/';
      fromInp.value = from || '';
      fromInp.style.cssText = inputStyle() + ';flex:1;width:auto;';

      var arrow = document.createElement('span');
      arrow.textContent = '→';
      arrow.style.cssText = 'color:#8b949e;flex-shrink:0;';

      var toInp = document.createElement('input');
      toInp.type = 'text';
      toInp.placeholder = 'http://localhost:8080/';
      toInp.value = to || '';
      toInp.style.cssText = inputStyle() + ';flex:1;width:auto;';

      var rmBtn = document.createElement('button');
      rmBtn.textContent = '✕';
      rmBtn.title = 'Удалить';
      rmBtn.style.cssText = [
        'background:#21262d', 'color:#8b949e', 'border:1px solid #444c56',
        'border-radius:5px', 'padding:3px 8px', 'font-size:12px',
        'cursor:pointer', 'flex-shrink:0',
      ].join(';');
      rmBtn.addEventListener('click', function () { rdList.removeChild(row); });

      row.appendChild(fromInp);
      row.appendChild(arrow);
      row.appendChild(toInp);
      row.appendChild(rmBtn);
      row._fromInp = fromInp;
      row._toInp = toInp;
      rdList.appendChild(row);
    }

    var addRdBtn = document.createElement('button');
    addRdBtn.textContent = '+ Добавить правило';
    addRdBtn.style.cssText = btnStyle(['font-size:12px', 'padding:3px 10px']);
    hoverBlue(addRdBtn);
    addRdBtn.addEventListener('click', function () { addRedirectRow('', ''); });
    box.appendChild(addRdBtn);

    // ── Action buttons ───────────────────────────────────────────────────────
    var actSep = document.createElement('div');
    actSep.style.cssText = 'border-top:1px solid #21262d;margin:20px 0 16px;';
    box.appendChild(actSep);

    var statusEl = document.createElement('div');
    statusEl.style.cssText = 'font-size:12px;min-height:18px;margin-bottom:10px;';
    box.appendChild(statusEl);

    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';

    var cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Отмена';
    cancelBtn.style.cssText = btnStyle();
    cancelBtn.addEventListener('mouseenter', function () {
      cancelBtn.style.background = '#30363d';
    });
    cancelBtn.addEventListener('mouseleave', function () {
      cancelBtn.style.background = '#21262d';
    });
    cancelBtn.addEventListener('click', function () {
      document.body.removeChild(overlay);
    });

    var saveBtn = document.createElement('button');
    saveBtn.textContent = 'Сохранить';
    saveBtn.style.cssText = [
      'background:#238636', 'color:#fff',
      'border:1px solid #2ea043', 'border-radius:5px',
      'padding:3px 14px', 'font-size:12px',
      'cursor:pointer', 'font-family:inherit',
      'transition:background 0.15s',
    ].join(';');
    saveBtn.addEventListener('mouseenter', function () { saveBtn.style.background = '#2ea043'; });
    saveBtn.addEventListener('mouseleave', function () { saveBtn.style.background = '#238636'; });

    saveBtn.addEventListener('click', function () {
      var glRows = glList.querySelectorAll('div[data-gl]') || glList.children;
      var gitlabs = [];
      for (var i = 0; i < glList.children.length; i++) {
        var r = glList.children[i];
        if (r._urlInp) gitlabs.push({ url: r._urlInp.value, token: r._tokInp.value });
      }
      var urlRedirects = [];
      for (var j = 0; j < rdList.children.length; j++) {
        var rr = rdList.children[j];
        if (rr._fromInp) urlRedirects.push({ from: rr._fromInp.value, to: rr._toInp.value });
      }

      var payload = {
        git: { name: gitName.input.value, email: gitEmail.input.value },
        gitlabs: gitlabs,
        urlRedirects: urlRedirects,
      };

      saveBtn.disabled = true;
      saveBtn.textContent = 'Сохранение…';
      statusEl.style.color = '#8b949e';
      statusEl.textContent = '';

      fetch('/__gateway/api/user/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Сохранить';
          if (data.ok) {
            statusEl.style.color = '#3fb950';
            statusEl.textContent = '✓ Настройки сохранены. Gitconfig обновлён.';
          } else {
            statusEl.style.color = '#f85149';
            statusEl.textContent = 'Ошибка: ' + (data.error || 'неизвестная ошибка');
          }
        })
        .catch(function (e) {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Сохранить';
          statusEl.style.color = '#f85149';
          statusEl.textContent = 'Ошибка сети: ' + e.message;
        });
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    box.appendChild(actions);

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // Close on overlay background click
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) document.body.removeChild(overlay);
    });

    // Load current settings
    fetch('/__gateway/api/user/settings')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        if (data.git) {
          gitName.input.value = data.git.name || '';
          gitEmail.input.value = data.git.email || '';
        }
        if (Array.isArray(data.gitlabs)) {
          data.gitlabs.forEach(function (g) { addGitlabRow(g.url, g.token); });
        }
        if (Array.isArray(data.urlRedirects)) {
          data.urlRedirects.forEach(function (r) { addRedirectRow(r.from, r.to); });
        }
      })
      .catch(function () {});
  }

  // ── Bar ───────────────────────────────────────────────────────────────────
  function createLogoutBar() {
    var bar = document.createElement('div');
    bar.id = '__gw_logout_bar';
    bar.style.cssText = [
      'position:fixed',
      'bottom:0',
      'right:0',
      'z-index:2147483647',
      'display:flex',
      'align-items:center',
      'gap:8px',
      'padding:5px 10px',
      'background:rgba(22,27,34,0.92)',
      'border-top-left-radius:8px',
      'border:1px solid #30363d',
      'border-bottom:none',
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

    // Settings button
    var settingsBtn = document.createElement('button');
    settingsBtn.textContent = '⚙';
    settingsBtn.title = 'Настройки';
    settingsBtn.style.cssText = btnStyle();
    hoverBlue(settingsBtn);
    settingsBtn.addEventListener('click', openSettings);
    bar.appendChild(settingsBtn);

    // Logout button
    var btn = document.createElement('button');
    btn.textContent = 'Выйти';
    btn.style.cssText = btnStyle();
    hoverRed(btn);
    btn.addEventListener('click', function () {
      var form = document.createElement('form');
      form.method = 'POST';
      form.action = '/__gateway/auth/logout';
      document.body.appendChild(form);
      form.submit();
    });
    bar.appendChild(btn);

    document.body.appendChild(bar);

    // Fetch current username and role
    fetch('/__gateway/api/me')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        if (data.username) userSpan.textContent = data.username;
        if (data.role === 'admin') {
          var adminBtn = document.createElement('a');
          adminBtn.textContent = 'Админ';
          adminBtn.href = '/__gateway/admin';
          adminBtn.target = '_blank';
          adminBtn.style.cssText = [
            'background:#21262d',
            'color:#cdd9e5',
            'border:1px solid #444c56',
            'border-radius:5px',
            'padding:3px 10px',
            'font-size:12px',
            'cursor:pointer',
            'font-family:inherit',
            'text-decoration:none',
            'transition:background 0.15s',
          ].join(';');
          hoverBlue(adminBtn);
          bar.insertBefore(adminBtn, settingsBtn);
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
