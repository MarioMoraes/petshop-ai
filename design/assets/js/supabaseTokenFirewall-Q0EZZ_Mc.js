const a="aura-supabase-token-firewall";function s(e){return e.replace(/\\/g,"\\\\").replace(/"/g,'\\"')}function u(e){try{return new URL(e).host}catch{return""}}function c(e){return`(function () {
  if (window.__AURA_SUPABASE_FIREWALL__) return;
  window.__AURA_SUPABASE_FIREWALL__ = true;

  var SUPABASE_HOST = "${s(e)}";
  var BLOCKED_KEY_PATTERNS = [
    /^sb-[a-z0-9-]+-auth-token$/i,
    /^supabase\\.auth\\.token$/i
  ];

  function isBlockedStorageKey(key) {
    if (typeof key !== "string") return false;
    for (var i = 0; i < BLOCKED_KEY_PATTERNS.length; i++) {
      if (BLOCKED_KEY_PATTERNS[i].test(key)) return true;
    }
    return false;
  }

  function toAbsoluteUrl(input) {
    try {
      return new URL(input, window.location.href);
    } catch {
      return null;
    }
  }

  function isSupabaseDestination(input) {
    var parsed = toAbsoluteUrl(input);
    if (!parsed) return false;
    if (SUPABASE_HOST && parsed.host === SUPABASE_HOST) return true;
    return parsed.host.endsWith(".supabase.co");
  }

  function pathLooksSensitive(input) {
    var parsed = toAbsoluteUrl(input);
    if (!parsed) return false;
    return /^\\/(auth|rest|functions)\\/v1\\//.test(parsed.pathname || "");
  }

  function headersContainAuth(headersLike) {
    if (!headersLike) return false;

    try {
      if (typeof Headers !== "undefined" && headersLike instanceof Headers) {
        return !!(headersLike.get("authorization") || headersLike.get("apikey"));
      }
    } catch {}

    if (Array.isArray(headersLike)) {
      for (var i = 0; i < headersLike.length; i++) {
        var pair = headersLike[i] || [];
        var name = String(pair[0] || "").toLowerCase();
        if (name === "authorization" || name === "apikey") return true;
      }
      return false;
    }

    if (typeof headersLike === "object") {
      var keys = Object.keys(headersLike);
      for (var j = 0; j < keys.length; j++) {
        var k = keys[j].toLowerCase();
        if (k === "authorization" || k === "apikey") return true;
      }
    }
    return false;
  }

  function requestLooksSensitive(input, init, extraHeaders) {
    var url = "";
    try {
      if (typeof input === "string") {
        url = input;
      } else if (input && typeof input.url === "string") {
        url = input.url;
      }
    } catch {}

    var headers =
      (init && init.headers) ||
      (input && input.headers) ||
      extraHeaders ||
      null;
    var hasAuthHeaders = headersContainAuth(headers);
    if (hasAuthHeaders) return true;

    if (!url) return false;
    if (isSupabaseDestination(url) && pathLooksSensitive(url)) return true;
    return false;
  }

  function patchStorage(storage, storageName) {
    if (!storage) return;
    var proto = Object.getPrototypeOf(storage);
    if (!proto || proto.__auraSupabaseFirewallPatched) return;

    var rawGetItem = proto.getItem;
    var rawSetItem = proto.setItem;
    var rawRemoveItem = proto.removeItem;
    var rawClear = proto.clear;
    var rawKey = proto.key;
    var rawLengthDescriptor = Object.getOwnPropertyDescriptor(proto, "length");
    var rawLengthGet = rawLengthDescriptor && rawLengthDescriptor.get;

    function getRawLength(instance) {
      try {
        if (rawLengthGet) return Number(rawLengthGet.call(instance) || 0);
      } catch {}
      try {
        return Number(instance.length || 0);
      } catch {}
      return 0;
    }

    function getVisibleKeys(instance) {
      var visible = [];
      var total = getRawLength(instance);
      for (var i = 0; i < total; i++) {
        var currentKey = rawKey.call(instance, i);
        if (currentKey && !isBlockedStorageKey(currentKey)) {
          visible.push(currentKey);
        }
      }
      return visible;
    }

    function maskBlockedKeyProperty(instance, keyName) {
      if (!keyName || !isBlockedStorageKey(keyName)) return;
      try {
        Object.defineProperty(instance, keyName, {
          configurable: true,
          enumerable: false,
          get: function () {
            return null;
          },
          set: function () {
            return true;
          }
        });
      } catch {}
    }

    function syncBlockedKeyProperties(instance) {
      var total = getRawLength(instance);
      for (var i = 0; i < total; i++) {
        var k = rawKey.call(instance, i);
        if (k) maskBlockedKeyProperty(instance, k);
      }
    }

    proto.getItem = function (key) {
      syncBlockedKeyProperties(this);
      if (isBlockedStorageKey(String(key))) return null;
      return rawGetItem.call(this, key);
    };

    proto.setItem = function (key, value) {
      if (isBlockedStorageKey(String(key))) return;
      return rawSetItem.call(this, key, value);
    };

    proto.removeItem = function (key) {
      if (isBlockedStorageKey(String(key))) return;
      return rawRemoveItem.call(this, key);
    };

    proto.clear = function () {
      if (typeof rawClear !== "function") return;

      // Preserve blocked keys across clear() to prevent auth token/session wipe.
      var preservedBlockedEntries = [];
      var total = getRawLength(this);
      for (var i = 0; i < total; i++) {
        var blockedKey = rawKey.call(this, i);
        if (blockedKey && isBlockedStorageKey(blockedKey)) {
          preservedBlockedEntries.push([
            blockedKey,
            rawGetItem.call(this, blockedKey),
          ]);
        }
      }

      rawClear.call(this);

      for (var j = 0; j < preservedBlockedEntries.length; j++) {
        var entry = preservedBlockedEntries[j];
        var key = entry[0];
        var value = entry[1];
        if (typeof key === "string" && typeof value === "string") {
          rawSetItem.call(this, key, value);
        }
      }

      syncBlockedKeyProperties(this);
    };

    proto.key = function (index) {
      syncBlockedKeyProperties(this);
      var visible = getVisibleKeys(this);
      return visible[index] || null;
    };

    try {
      Object.defineProperty(proto, "length", {
        configurable: true,
        enumerable: false,
        get: function () {
          syncBlockedKeyProperties(this);
          return getVisibleKeys(this).length;
        }
      });
    } catch {}

    var proxyStorage = null;
    try {
      proxyStorage = new Proxy(storage, {
        get: function (target, prop) {
          if (typeof prop === "string" && isBlockedStorageKey(prop)) return null;
          if (prop === "length") return getVisibleKeys(target).length;
          if (prop === "key") {
            return function (index) {
              var visible = getVisibleKeys(target);
              return visible[index] || null;
            };
          }
          if (prop === "clear") {
            return function () {
              if (typeof rawClear !== "function") return;

              var preservedBlockedEntries = [];
              var total = getRawLength(target);
              for (var i = 0; i < total; i++) {
                var blockedKey = rawKey.call(target, i);
                if (blockedKey && isBlockedStorageKey(blockedKey)) {
                  preservedBlockedEntries.push([
                    blockedKey,
                    rawGetItem.call(target, blockedKey),
                  ]);
                }
              }

              rawClear.call(target);

              for (var j = 0; j < preservedBlockedEntries.length; j++) {
                var entry = preservedBlockedEntries[j];
                var key = entry[0];
                var value = entry[1];
                if (typeof key === "string" && typeof value === "string") {
                  rawSetItem.call(target, key, value);
                }
              }

              syncBlockedKeyProperties(target);
            };
          }

          var value = target[prop];
          if (typeof value === "function") return value.bind(target);
          return value;
        },
        set: function (target, prop, value) {
          if (typeof prop === "string" && isBlockedStorageKey(prop)) return true;
          target[prop] = value;
          return true;
        },
        has: function (target, prop) {
          if (typeof prop === "string" && isBlockedStorageKey(prop)) return false;
          return prop in target;
        },
        deleteProperty: function (target, prop) {
          if (typeof prop === "string" && isBlockedStorageKey(prop)) return true;
          try {
            delete target[prop];
          } catch {}
          return true;
        },
        ownKeys: function (target) {
          return getVisibleKeys(target);
        },
        getOwnPropertyDescriptor: function (target, prop) {
          if (typeof prop === "string" && isBlockedStorageKey(prop)) {
            return undefined;
          }
          if (prop === "length") {
            return {
              configurable: true,
              enumerable: false,
              value: getVisibleKeys(target).length,
              writable: false
            };
          }
          return Object.getOwnPropertyDescriptor(target, prop);
        }
      });
    } catch {}

    try {
      if (proxyStorage) {
        Object.defineProperty(window, storageName, {
          configurable: true,
          enumerable: true,
          get: function () {
            return proxyStorage;
          }
        });
      }
    } catch {}

    syncBlockedKeyProperties(storage);
    proto.__auraSupabaseFirewallPatched = true;
  }

  function patchCookieAccess() {
    try {
      var cookieDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
      if (!cookieDescriptor || !cookieDescriptor.configurable) return;

      Object.defineProperty(document, "cookie", {
        configurable: true,
        enumerable: false,
        get: function () {
          return "";
        },
        set: function () {
          return true;
        }
      });
    } catch {}
  }

  function patchFetch() {
    if (typeof window.fetch !== "function") return;
    var rawFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      if (requestLooksSensitive(input, init, null)) {
        return Promise.reject(new Error("Blocked by Aura security policy"));
      }
      return rawFetch(input, init);
    };
  }

  function patchXHR() {
    if (typeof XMLHttpRequest === "undefined") return;
    var rawOpen = XMLHttpRequest.prototype.open;
    var rawSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    var rawSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
      this.__auraRequestUrl = String(url || "");
      this.__auraHeaders = {};
      return rawOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      if (!this.__auraHeaders) this.__auraHeaders = {};
      this.__auraHeaders[String(name || "").toLowerCase()] = String(value || "");
      return rawSetHeader.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function () {
      if (requestLooksSensitive(this.__auraRequestUrl || "", null, this.__auraHeaders || null)) {
        throw new Error("Blocked by Aura security policy");
      }
      return rawSend.apply(this, arguments);
    };
  }

  function patchBeacon() {
    if (typeof navigator.sendBeacon !== "function") return;
    var rawBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      if (requestLooksSensitive(url, null, null)) return false;
      return rawBeacon(url, data);
    };
  }

  function patchWebSocket() {
    if (typeof WebSocket === "undefined") return;
    var RawWebSocket = WebSocket;
    window.WebSocket = function (url, protocols) {
      if (requestLooksSensitive(String(url || ""), null, null)) {
        throw new Error("Blocked by Aura security policy");
      }
      return new RawWebSocket(url, protocols);
    };
    window.WebSocket.prototype = RawWebSocket.prototype;
  }

  patchStorage(window.localStorage, "localStorage");
  patchStorage(window.sessionStorage, "sessionStorage");
  patchCookieAccess();
  patchFetch();
  patchXHR();
  patchBeacon();
  patchWebSocket();
})();`}function l(e,n){if(!e||e.includes(a))return e;const o=u(n),i=c(o),t=`<script id="${a}">${i}<\/script>`;return/<head[^>]*>/i.test(e)?e.replace(/<head[^>]*>/i,r=>`${r}
${t}`):/<body[^>]*>/i.test(e)?e.replace(/<body[^>]*>/i,r=>`${r}
${t}`):`<!DOCTYPE html><html><head>${t}</head><body>${e}</body></html>`}export{l as i};
