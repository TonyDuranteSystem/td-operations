package com.tonydurante.myllcmanager

/**
 * Script run at the start of every page of OUR site (never another site). The portal makes its downloads from an in-page file ("blob:" links), which an Android
 * web view cannot download by itself, so this hands such a file to the app: the app saves it and opens it in the phone's viewer. The same message door
 * (`window.tdclientAndroid`) carries the Menu button and the company choice (components/portal/client-app-frame.tsx).
 */
object PageBridge {
    /** The one place the script is defined; it only does anything inside the app (the door `tdclientAndroid` exists only there). */
    val SCRIPT: String = """
(function () {
  if (window.__tdBridgeInstalled) return;
  window.__tdBridgeInstalled = true;
  var blobs = new Map();
  var door = function () { return window.tdclientAndroid; };

  // keep every in-page file until the page is gone: the page may free its address right after clicking the link
  var originalCreate = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    var url = originalCreate.apply(URL, arguments);
    try { if (obj instanceof Blob) blobs.set(url, obj); } catch (e) {}
    return url;
  };

  function toApp(blob, name) {
    var reader = new FileReader();
    reader.onloadend = function () {
      var text = String(reader.result || '');
      var comma = text.indexOf(',');
      if (!door()) return;
      door().postMessage('file:' + JSON.stringify({ name: name || '', type: blob.type || '', data: comma >= 0 ? text.slice(comma + 1) : '' }));
    };
    reader.readAsDataURL(blob);
  }

  window.__tdSendBlob = function (url, name) {
    var known = blobs.get(url);
    if (known) { toApp(known, name); return; }
    fetch(url).then(function (r) { return r.blob(); }).then(function (b) { toApp(b, name); }).catch(function () {
      if (door()) door().postMessage('file-error:');
    });
  };

  var originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    try {
      if (door() && this.href && this.href.indexOf('blob:') === 0 && this.hasAttribute('download')) {
        window.__tdSendBlob(this.href, this.getAttribute('download'));
        return;
      }
    } catch (e) {}
    return originalClick.apply(this, arguments);
  };

  document.addEventListener('click', function (event) {
    var link = event.target && event.target.closest ? event.target.closest('a[download]') : null;
    if (door() && link && link.href && link.href.indexOf('blob:') === 0) {
      event.preventDefault();
      window.__tdSendBlob(link.href, link.getAttribute('download'));
    }
  }, true);
})();
""".trimIndent()
}
