/* =====================================================================
 *  DEVICE WRAPPER  (runs before the React bundle)
 *  - window.storage  -> backed by localStorage (persists on the phone)
 *  - window.fetch    -> if an API key is saved, calls the real Anthropic
 *                       API; otherwise returns realistic DEMO responses so
 *                       the app fully works offline out of the box.
 *  - A small ⚙ button lets the user paste/clear their Anthropic API key.
 * ===================================================================== */
(function () {
  /* ---------------- storage shim ---------------- */
  var ns = function (shared) {
    return shared ? "shared::" : "personal::";
  };
  window.storage = {
    get: function (key, opts) {
      opts = opts || {};
      return Promise.resolve(localStorage.getItem(ns(opts.shared) + key));
    },
    set: function (key, value, opts) {
      opts = opts || {};
      localStorage.setItem(ns(opts.shared) + key, value);
      return Promise.resolve();
    },
    delete: function (key, opts) {
      opts = opts || {};
      localStorage.removeItem(ns(opts.shared) + key);
      return Promise.resolve();
    },
    list: function (opts) {
      opts = opts || {};
      var base = ns(opts.shared);
      var prefix = base + (opts.prefix || "");
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(prefix) === 0) keys.push(k.slice(base.length));
      }
      return Promise.resolve(keys);
    },
  };

  /* ---------------- API key helpers ---------------- */
  function getKey() {
    try {
      return localStorage.getItem("cfg::anthropicKey") || "";
    } catch (e) {
      return "";
    }
  }
  function setKey(k) {
    try {
      if (k) localStorage.setItem("cfg::anthropicKey", k);
      else localStorage.removeItem("cfg::anthropicKey");
    } catch (e) {}
  }

  /* ---------------- demo responses ---------------- */
  function delay(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }
  function jsonResp(obj) {
    return new Response(
      JSON.stringify({ content: [{ type: "text", text: JSON.stringify(obj) }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
  var DEMO_NOTE_V1 = {
    header: "CSIR TKDL UNIT",
    department: "Finance and Accounts",
    date: "14/11/2024",
    subject:
      "Pre-audit observations on Bill no. 45100108 of M/s Sansanwal Travels — reg.",
    hindiSubject: "",
    reference: "Bill no. 45100108 dated 13/11/2024 of M/s Sansanwal Travels",
    paragraphs: [
      "It is submitted that the above-cited bill no. 45100108 dated 13/11/2024 of M/s Sansanwal Travels has been received for pre-audit. During pre-audit, certain observations have been noticed which require clarification before the bill can be processed for payment.",
      "It is observed that a rate of Rs. 7.68 (inclusive of GST) has been applied for 602 extra kilometres. As per GeM Contract no. 511687757198526 dated 30/01/2023, a copy of which is enclosed, this rate does not appear to be in order.",
      "In view of the above, it is requested that the said observation may kindly be clarified, or the bill may be restricted as necessary, so that the present bill can be processed for payment.",
    ],
    detailsBlock: [
      { label: "Bill No.", value: "45100108 dated 13/11/2024" },
      { label: "Vendor", value: "M/s Sansanwal Travels" },
      { label: "Contract Ref.", value: "GeM No. 511687757198526 dated 30/01/2023" },
      { label: "Observation", value: "Extra 602 km @ Rs. 7.68 (incl. GST)" },
    ],
    closingLine:
      "Submitted for further consideration and necessary action please.",
    signatureChain: ["SO (F&A)", "DFA (F&A)", "DS/DDO (TKDL)"],
    language: "English",
  };
  function demoNoteV2() {
    var v2 = JSON.parse(JSON.stringify(DEMO_NOTE_V1));
    v2.hindiSubject =
      "मेसर्स सनसंवाल ट्रेवल्स के बिल संख्या 45100108 पर प्री-ऑडिट निरीक्षण बिंदु — विषयक।";
    return v2;
  }
  function demoFor(sys, user) {
    if (sys.indexOf("analyzing a formal government office noting") !== -1) {
      return {
        styleRules: {
          tone: "Formal, third-person Hindi/English government style",
          openingPhrase: "प्रस्तुत बिल संख्या ...",
          closingPhrase: "... ताकि वर्तमान बिल को भुगतान हेतु प्रोसेस किया जा सके।",
          paragraphCount: 2,
          usesHindi: true,
          hindiPattern: "full",
        },
        signatureChain: ["SO (F&A)", "F&A", "DDO"],
        subjectLinePattern:
          "Bill no [number] of M/s [party] — pre-audit observations — reg.",
        keyPhrases: [
          "प्रस्तुत बिल संख्या",
          "प्री-ऑडिट के दौरान",
          "निरीक्षण बिंदु सामने आये",
          "स्पष्ट किया जा सकता है",
          "भुगतान हेतु प्रोसेस किया जा सके",
        ],
        tags: ["Finance", "Audit"],
        language: "Hindi",
      };
    }
    if (sys.indexOf("distilling permanent, reusable learning") !== -1) {
      return {
        learnings: [
          "Open with the bill/document reference: 'प्रस्तुत बिल संख्या ... तारीख ...'",
          "List each pre-audit observation as a clearly numbered point",
          "Cite the exact contract/circular number and date, noting 'प्रति संलग्न' when enclosed",
          "Maintain formal third-person tone throughout",
          "Close with: 'ताकि वर्तमान बिल को भुगतान हेतु प्रोसेस किया जा सके।'",
          "Place signature chain (SO (F&A) → F&AO → DDO) at the foot of the note",
        ],
      };
    }
    if (user.indexOf("Extract all key facts") !== -1) {
      return {
        subject:
          "Pre-audit observations on Bill no. 45100108 of M/s Sansanwal Travels — reg.",
        date: "14/11/2024",
        organization: "CSIR TKDL UNIT",
        parties: ["M/s Sansanwal Travels"],
        amounts: [
          { value: "Rs. 7.68", description: "rate for 602 extra km (incl. GST)" },
        ],
        accountNumbers: [],
        ruleReferences: ["GeM Contract No. 511687757198526 dated 30/01/2023"],
        purpose: "Pre-audit of travel bill",
        requestedAction: "Clarify extra-km rate or restrict the bill",
        budgetHead: "TKDL — Travel",
        additionalFacts: { enclosure: "Contract copy enclosed" },
      };
    }
    if (user.indexOf("Here is the current note") !== -1) {
      return demoNoteV2();
    }
    return DEMO_NOTE_V1;
  }

  /* ---------------- fetch override ---------------- */
  var realFetch = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    opts = opts || {};
    var u = typeof url === "string" ? url : (url && url.url) || "";
    if (u.indexOf("api.anthropic.com") !== -1) {
      var key = getKey();
      var body = {};
      try {
        body = JSON.parse(opts.body);
      } catch (e) {}
      if (!key) {
        // DEMO mode
        return delay(800).then(function () {
          return jsonResp(
            demoFor(
              body.system || "",
              (body.messages && body.messages[0] && body.messages[0].content) ||
                ""
            )
          );
        });
      }
      // REAL call with the user's key
      var headers = Object.assign({}, opts.headers || {}, {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        "content-type": "application/json",
      });
      return realFetch(url, Object.assign({}, opts, { headers: headers }));
    }
    return realFetch(url, opts);
  };

  /* ---------------- settings (⚙ API key) UI ---------------- */
  function injectSettings() {
    var btn = document.createElement("button");
    btn.textContent = "⚙";
    btn.title = "AI Settings (API key)";
    // sit above the mobile bottom tab bar on phones
    var isMobile = window.matchMedia("(max-width: 767px)").matches;
    btn.style.cssText =
      "position:fixed;bottom:" +
      (isMobile ? 72 : 16) +
      "px;left:12px;z-index:9999;width:40px;height:40px;border-radius:9999px;border:none;background:#2563eb;color:#fff;font-size:18px;box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:pointer;";
    btn.onclick = openPanel;
    document.body.appendChild(btn);

    function openPanel() {
      var overlay = document.createElement("div");
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:16px;";
      var card = document.createElement("div");
      card.style.cssText =
        "background:#fff;border-radius:12px;max-width:420px;width:100%;padding:18px;font-family:sans-serif;color:#111;";
      var key = getKey();
      card.innerHTML =
        '<h3 style="margin:0 0 8px;font-size:16px;font-weight:700;">AI Settings</h3>' +
        '<p style="margin:0 0 10px;font-size:12px;color:#555;line-height:1.4;">' +
        "Paste your <b>Anthropic API key</b> (from console.anthropic.com) to enable real AI note-writing. " +
        "Leave it blank to keep using the built-in <b>demo mode</b>. The key is stored only on this phone." +
        "</p>" +
        '<input id="ck_key" type="password" placeholder="sk-ant-..." value="' +
        (key ? key.replace(/"/g, "&quot;") : "") +
        '" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #ccc;border-radius:8px;font-size:13px;margin-bottom:6px;"/>' +
        '<p style="margin:0 0 12px;font-size:11px;color:' +
        (key ? "#16a34a" : "#6b7280") +
        ';">' +
        (key ? "✓ Real AI is enabled." : "Currently running in demo mode.") +
        "</p>" +
        '<div style="display:flex;gap:8px;">' +
        '<button id="ck_save" style="flex:1;padding:8px;border:none;border-radius:8px;background:#2563eb;color:#fff;font-weight:600;cursor:pointer;">Save</button>' +
        '<button id="ck_clear" style="flex:1;padding:8px;border:none;border-radius:8px;background:#f3f4f6;color:#374151;cursor:pointer;">Use demo</button>' +
        '<button id="ck_close" style="flex:1;padding:8px;border:none;border-radius:8px;background:#f3f4f6;color:#374151;cursor:pointer;">Cancel</button>' +
        "</div>";
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      overlay.addEventListener("click", function (e) {
        if (e.target === overlay) document.body.removeChild(overlay);
      });
      card.querySelector("#ck_save").onclick = function () {
        setKey(card.querySelector("#ck_key").value.trim());
        location.reload();
      };
      card.querySelector("#ck_clear").onclick = function () {
        setKey("");
        location.reload();
      };
      card.querySelector("#ck_close").onclick = function () {
        document.body.removeChild(overlay);
      };
    }
  }
  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", injectSettings);
  } else {
    injectSettings();
  }
})();
