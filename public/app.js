// Behaviours that used to be inline handlers, kept in a file rather than in
// the markup so the Content-Security-Policy can forbid inline script.


(function () {
  'use strict';

  var STORAGE_KEY = 'sareit-theme';

  var settle = 0;

  function stored() {
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      // Storage is unavailable in private browsing on some browsers. The
      // default still applies, the choice just does not persist.
      return null;
    }
  }

  function remember(value) {
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch (err) {
      // As above: no storage, no persistence, no breakage.
    }
  }

  function current() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  // The button names the theme it switches to, so it reads from the same place
  // the theme does. It lives in the masthead, which does not exist yet while the
  // head script runs, so apply() finds nothing on the first pass and this is
  // called again once the document has been parsed.
  function syncButton(theme) {
    var button = document.querySelector('[data-theme-toggle]');
    if (button) button.textContent = theme === 'dark' ? 'Light' : 'Dark';
  }

  // animate is false for the first paint of a page. The transition is driven by
  // a temporary class, so only a deliberate toggle adds it: opening a page in
  // light mode must not fade the whole page in from dark on every navigation.
  function apply(theme, animate) {
    document.documentElement.setAttribute('data-theme', theme);
    if (animate) {
      // The class turns the transition on for the length of the fade and then
      // comes off again, so a later repaint does not animate on its own.
      document.documentElement.classList.add('theme-animated');
      window.clearTimeout(settle);
      settle = window.setTimeout(function () {
        document.documentElement.classList.remove('theme-animated');
      }, 260);
    }
    syncButton(theme);
  }

  apply(stored() === 'light' ? 'light' : 'dark', false);

  document.addEventListener('DOMContentLoaded', function () {
    // The masthead exists now, so the button can finally be told which theme is
    // in effect. Without this, a reader who chose light is shown "Light" as if
    // that were the theme already on screen.
    syncButton(current());

    var toggle = document.querySelector('[data-theme-toggle]');
    if (toggle) {
      toggle.addEventListener('click', function () {
        var next = current() === 'dark' ? 'light' : 'dark';
        apply(next, true);
        remember(next);
      });
    }

    var auto = document.querySelectorAll('[data-autosubmit]');
    for (var i = 0; i < auto.length; i++) {
      auto[i].addEventListener('change', function () {
        if (this.form) this.form.submit();
      });
    }

    var pickers = document.querySelectorAll('[data-select-on-click]');
    for (var j = 0; j < pickers.length; j++) {
      pickers[j].addEventListener('focus', function () {
        this.select();
      });
    }

    // A destructive action gets one confirmation. The message is authored in
    // the markup, so it travels with the form rather than with this file.
    var guarded = document.querySelectorAll('form[data-confirm]');
    for (var k = 0; k < guarded.length; k++) {
      guarded[k].addEventListener('submit', function (event) {
        if (!window.confirm(this.getAttribute('data-confirm'))) event.preventDefault();
      });
    }

    // A copy button next to a value, one per value. The clipboard API is only
    // available over https or on localhost, and this platform is usually served
    // on plain http, so a selection-based fallback is the normal path rather
    // than the exception.
    var copyables = document.querySelectorAll('[data-copy]');
    for (var m = 0; m < copyables.length; m++) {
      copyables[m].addEventListener('click', function () {
        copyValue(this.getAttribute('data-copy'), this);
      });
    }

    var importer = document.querySelector('[data-import-status]');
    if (importer) followImport(importer);

    // Caught on submit rather than on input, so the command never becomes a query
    // string and never reaches the catalog search.
    var search = document.querySelector('form.search');
    if (search) {
      search.addEventListener('submit', function (event) {
        var field = search.querySelector('input[name="q"]');
        var typed = field.value.trim().toLowerCase();
        if (typed !== DEBUG_ON && typed !== DEBUG_OFF) return;
        event.preventDefault();
        field.value = '';
        if (typed === DEBUG_ON) showDebug();
        else hideDebug();
      });
    }

    if (sessionDebug() === 'on') showDebug();
  });

  // Live counters for the host, switched on by typing //debugEnable into the
  // search box. Nothing global is defined for it, so it is not reachable from
  // the console or from a script on the page.
  var DEBUG_ON = '//debugenable';
  var DEBUG_OFF = '//debugdisable';
  var DEBUG_KEY = 'sareit-debug';
  var debugTimer = null;
  var debugBaseline = 0;

  // Only web storage survives a page load, so that is what carries the choice
  // across a navigation. It also survives a reload, which is not wanted here, so
  // a reload clears it. Back and Forward are not reloads and keep it.
  var RELOADED = (function () {
    var entries = performance.getEntriesByType ? performance.getEntriesByType('navigation') : [];
    return entries.length > 0 && entries[0].type === 'reload';
  })();

  function sessionDebug() {
    try {
      return window.sessionStorage.getItem(DEBUG_KEY);
    } catch (err) {
      return null;
    }
  }

  function rememberDebug(value) {
    try {
      window.sessionStorage.setItem(DEBUG_KEY, value);
    } catch (err) {
      // Storage unavailable: the overlay still works, it just resets on reload.
    }
  }

  if (RELOADED) rememberDebug('off');

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + 'B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + 'KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + 'MB';
    return (bytes / 1073741824).toFixed(2) + 'GB';
  }

  function paint(state) {
    document.getElementById('t').textContent = state.lastMs + 'ms';
    document.getElementById('c').textContent = String(state.inflight);
    // The server counts from boot. What the overlay shows is what happened after
    // it was switched on, so the total is measured first and subtracted.
    document.getElementById('d').textContent = formatBytes(Math.max(0, state.bytes - debugBaseline));
  }

  function poll() {
    window.fetch('/_debug/state', { credentials: 'same-origin' })
      .then(function (answer) {
        return answer.ok ? answer.json() : null;
      })
      .then(function (state) {
        if (state) paint(state);
      })
      .catch(function () {
        // A failed poll leaves the last numbers up rather than blanking them: a
        // stale reading is still more use than none.
      });
  }

  function showDebug() {
    var panel = document.getElementById('Debug');
    if (!panel) return;
    rememberDebug('on');
    window.clearInterval(debugTimer);
    debugTimer = window.setInterval(poll, 500);
    window
      .fetch('/_debug/state', { credentials: 'same-origin' })
      .then(function (answer) {
        return answer.ok ? answer.json() : null;
      })
      .then(function (state) {
        if (!state) return;
        debugBaseline = state.bytes;
        panel.hidden = false;
        paint(state);
      });
  }

  function hideDebug() {
    rememberDebug('off');
    window.clearInterval(debugTimer);
    debugTimer = null;
    var panel = document.getElementById('Debug');
    if (panel) panel.hidden = true;
  }

  function copied(button, ok) {
    var was = button.textContent;
    button.textContent = ok ? 'Copied' : 'Press Ctrl+C';
    button.classList.toggle('copy-done', ok);
    window.setTimeout(function () {
      button.textContent = was;
      button.classList.remove('copy-done');
    }, 1500);
  }

  function copyValue(text, button) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(
        function () { copied(button, true); },
        function () { copied(button, selectAndCopy(text)); }
      );
      return;
    }
    copied(button, selectAndCopy(text));
  }

  // The old way: put the text in a selection and ask the document to copy it.
  // The textarea is off-screen rather than hidden because a display:none element
  // cannot be selected, which is what makes this fail on the browsers that still
  // need it.
  function selectAndCopy(text) {
    var field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.top = '-1000px';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (err) {
      ok = false;
    }
    document.body.removeChild(field);
    return ok;
  }

// The number on the bar is git's own, read back out of the job, so there is
  // nothing here to guess. Done and failed both reload the same page, which is
  // what turns the panel into a file list or a finished repository.
  function followImport(panel) {
    var statusUrl = panel.getAttribute('data-import-status');
    var fill = panel.querySelector('[data-import-bar]');
    var phase = panel.querySelector('[data-import-phase]');
    var elapsed = panel.querySelector('[data-import-elapsed]');
    var unreachable = 0;

    function paint(job) {
      if (job.reported) {
        fill.style.width = job.percent + '%';
        fill.removeAttribute('data-moving');
        fill.parentNode.setAttribute('aria-valuenow', job.percent);
      }
      if (phase) phase.textContent = job.phase;
      if (job.detail && phase) phase.appendChild(document.createTextNode(' ' + job.detail));
      if (elapsed) {
        var seconds = job.seconds;
        elapsed.textContent = (seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's') + ' elapsed.';
      }
    }

    function ask() {
      window.fetch(statusUrl, { credentials: 'same-origin' })
        .then(function (answer) {
          return answer.ok ? answer.json() : null;
        })
        .then(function (job) {
          unreachable = 0;
          // idle, done and failed all mean the copy is not running, and the page
          // they reload into is the one that says so.
          if (job && job.state !== 'running' && job.state !== 'queued') {
            window.location.reload();
            return;
          }
          if (job) paint(job);
        })
        .catch(function () {
          unreachable += 1;
          if (unreachable >= 5 && phase) phase.textContent = 'Lost contact with the server, still retrying.';
        })
        .then(function () {
          window.setTimeout(ask, 1000);
        });
    }

    ask();
  }
})();
