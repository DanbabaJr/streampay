/**
 * StreamPay Embed Loader v1.0.0
 *
 * Drop this script onto any page to enable the <streampay-stream> custom
 * element. Use SRI integrity to pin a specific build:
 *
 *   <script
 *     src="https://app.streampay.example/embed/loader.js"
 *     integrity="sha384-<hash>"
 *     crossorigin="anonymous"
 *   ></script>
 *
 * The loader records the script's own origin so the web component can
 * construct iframe URLs that point back at the same host, then loads the
 * web component module.
 *
 * Security note: this file is intentionally tiny and free of eval and dynamic
 * code execution. The web component module handles all runtime logic.
 */
(function () {
  "use strict";

  // Record the base URL for the web component to use when constructing the
  // iframe src. We detect it from this script's own src attribute.
  var scripts = document.querySelectorAll("script[src*=\"loader.js\"]");
  var src = scripts.length > 0 ? scripts[scripts.length - 1].src : "";
  var base = src ? src.replace(/\/embed\/loader\.js.*$/, "") : window.location.origin;
  window.__STREAMPAY_EMBED_BASE__ = base;

  // Load the web component as an ES module. Browsers that support custom
  // elements also support ES modules, so no transpilation fallback is needed.
  var mod = document.createElement("script");
  mod.type = "module";
  // This path resolves relative to the page, not this script.
  mod.src = base + "/embed/widget.js";
  document.head.appendChild(mod);
})();
