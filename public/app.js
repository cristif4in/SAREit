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

    var importer = document.querySelector('[data-import-status]');
    if (importer) followImport(importer);
  });

  // The import page follows the copy the server is running. The number on the
  // bar is git's own, read back out of the job, so there is nothing here to
  // guess: a clone that reports no percentage leaves the bar crawling, and a
  // copy that has finished or failed is a different page, which is what the
  // browser navigates to.
  function followImport(panel) {
    var statusUrl = panel.getAttribute('data-import-status');
    var fill = panel.querySelector('[data-import-bar]');
    var phase = panel.querySelector('[data-import-phase]');
    var unreachable = 0;

    function paint(job) {
      if (job.reported) {
        fill.style.width = job.percent + '%';
        fill.removeAttribute('data-moving');
        fill.parentNode.setAttribute('aria-valuenow', job.percent);
      }
      phase.textContent = job.phase;
      if (job.detail) phase.appendChild(document.createTextNode(' ' + job.detail));
    }

    function ask() {
      window.fetch(statusUrl, { credentials: 'same-origin' })
        .then(function (answer) {
          return answer.ok ? answer.json() : null;
        })
        .then(function (job) {
          unreachable = 0;
          // A job that is gone, finished or failed all have somewhere else to
          // be read. Assigning is what lands the browser there.
          if (job && job.state !== 'running') {
            window.location.assign(job.location);
            return;
          }
          if (job) paint(job);
        })
        .catch(function () {
          unreachable += 1;
          if (unreachable >= 5) phase.textContent = 'Lost contact with the server, still retrying.';
        })
        .then(function () {
          window.setTimeout(ask, 1000);
        });
    }

    ask();
  }
})();
