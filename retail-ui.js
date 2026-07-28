/* ============================================================
   retail-ui.js — Retail AI · shared UI behaviors
   ------------------------------------------------------------
   Pure JS, zero dependencies. Browser: window.RetailUI.
   Node (tests): module.exports.

   Contains ONLY behavior confirmed independently reimplemented
   with the same contract across multiple tools. Currently:

   - wireDropZone(zone, input, opts): the drag-and-drop file
     upload pattern every tool's upload UI already follows —
     dragover/dragenter add an active class, dragleave/drop
     remove it, drop and file-input change both hand the picked
     file to a callback. opts.activeClass and opts.onFile let
     each tool keep its own class names and handling.
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RetailUI = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

function wireDropZone(zone, input, opts) {
  opts = opts || {};
  var activeClass = opts.activeClass || 'drag';
  var onFile = opts.onFile || function () {};

  zone.addEventListener('click', function () { input.click(); });
  zone.addEventListener('dragover', function (e) { e.preventDefault(); zone.classList.add(activeClass); });
  zone.addEventListener('dragleave', function () { zone.classList.remove(activeClass); });
  zone.addEventListener('drop', function (e) {
    e.preventDefault();
    zone.classList.remove(activeClass);
    if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
  });
  input.addEventListener('change', function () {
    if (input.files[0]) onFile(input.files[0]);
  });
}

return { wireDropZone: wireDropZone };
}));
