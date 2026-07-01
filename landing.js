/* Granite Logistics — landing page: PWA install, tracking deep-link. */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };

  // Year
  var y = $("#year"); if (y) y.textContent = new Date().getFullYear();

  // ---- Toast helper ----
  function toast(msg) {
    var el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    $("#toasts").appendChild(el);
    setTimeout(function () { el.style.transition = ".3s"; el.style.opacity = "0"; el.style.transform = "translateX(20px)"; }, 3400);
    setTimeout(function () { el.remove(); }, 3800);
  }

  // ---- PWA install ----
  var installBtn = $("#install-btn");
  var hint = $("#install-hint");
  var deferredPrompt = null;
  var standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

  if (standalone) {
    // Already installed — repurpose the button to open the platform.
    installBtn.innerHTML = "Open the Platform &rarr;";
    installBtn.addEventListener("click", function () { window.location.href = "app.html"; });
  } else {
    window.addEventListener("beforeinstallprompt", function (e) {
      e.preventDefault();
      deferredPrompt = e;
      installBtn.classList.add("ready");
      hint.textContent = "Ready to install — one tap adds Granite Logistics to your device.";
    });

    installBtn.addEventListener("click", function () {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then(function (choice) {
          if (choice.outcome === "accepted") toast("Installing Granite Logistics…");
          else toast("Install dismissed — you can do it anytime.");
          deferredPrompt = null;
        });
      } else {
        // Fallback for browsers without the install prompt (iOS Safari, etc.)
        var ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
        toast(ios
          ? "On iPhone: tap Share, then “Add to Home Screen.”"
          : "Use your browser menu → “Install app” / “Add to Home Screen.”");
      }
    });

    window.addEventListener("appinstalled", function () { toast("Installed. Find Granite Logistics on your home screen."); });
  }

  // ---- Tracking deep-link into the platform ----
  $("#track-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var val = $("#track-input").value.trim();
    window.location.href = "track.html" + (val ? "?n=" + encodeURIComponent(val) : "");
  });

  // ---- Service worker (installable / offline) ----
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () { navigator.serviceWorker.register("sw.js").catch(function () { }); });
  }
})();
