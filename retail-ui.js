/* ============================================================
   retail-ui.js — Retail AI · shared UI behaviors
   ------------------------------------------------------------
   Pure JS, zero dependencies. Browser: window.RetailUI.
   Node (tests): module.exports.

   wireDropZone(zone, input, opts): the drag-and-drop file-intake
   pattern every tool's upload UI reimplements. Verified against
   every tool's actual code before this was written — the options
   below exist because tools genuinely differ, not as speculative
   flexibility:

     activeClass      default 'drag'  — class toggled on the zone
     groupedEvents    default false   — false: bare dragover/dragleave,
                                        no preventDefault on leave
                                        (Inventory_Audit_Toolf1's
                                        original contract).
                                        true: grouped dragenter+dragover
                                        (add) / dragleave+drop (remove),
                                        preventDefault on both groups.
     multiple         default false   — false: onFile(file) with
                                        files[0]. true: onFile(fileList)
                                        with the whole FileList.
     requireNonEmpty  default true    — guard before calling onFile.
                                        Set false only to reproduce
                                        BlueDart_Etail_Waybill_Builder1's
                                        one call site that invokes its
                                        handler unconditionally, even
                                        on an empty drop.
     bindClick        default true    — attach a plain
                                        zone.click -> input.click()
                                        listener. Set false when a tool
                                        wires its own click behavior
                                        (nested-button guards,
                                        stopPropagation, keyboard
                                        access, or a native <label>
                                        that already opens the picker).

   Defaults reproduce Inventory_Audit_Toolf1.html's original inline
   implementation exactly, so its existing call site needs no change.
   input's change listener is wired whenever input is passed,
   independent of bindClick.
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
  var grouped = !!opts.groupedEvents;
  var multiple = !!opts.multiple;
  var requireNonEmpty = opts.requireNonEmpty !== false;
  var bindClick = opts.bindClick !== false;

  var enterEvents = grouped ? ['dragenter', 'dragover'] : ['dragover'];
  var leaveEvents = grouped ? ['dragleave', 'drop'] : ['dragleave'];

  function extract(fileListLike) {
    if (multiple) {
      if (!requireNonEmpty || fileListLike.length) onFile(fileListLike);
    } else {
      var f = fileListLike[0];
      if (!requireNonEmpty || f) onFile(f);
    }
  }

  if (bindClick) {
    zone.addEventListener('click', function () { input.click(); });
  }

  enterEvents.forEach(function (ev) {
    zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add(activeClass); });
  });
  leaveEvents.forEach(function (ev) {
    zone.addEventListener(ev, function (e) {
      if (grouped) e.preventDefault();
      zone.classList.remove(activeClass);
    });
  });

  zone.addEventListener('drop', function (e) {
    e.preventDefault();
    zone.classList.remove(activeClass);
    extract(e.dataTransfer.files);
  });

  if (input) {
    input.addEventListener('change', function () {
      extract(input.files);
    });
  }
}

return { wireDropZone: wireDropZone };
}));
