/* =====================================================================
 *  DEVICE WRAPPER  (runs before the React bundle)
 *  - window.storage  -> backed by localStorage (persists on the phone)
 *  - window.fetch    -> if an API key is saved, calls the OpenAI Responses
 *                       API; otherwise returns realistic DEMO responses so
 *                       the app fully works offline out of the box.
 *  - A small settings button lets the user paste/clear their OpenAI API key.
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

  /* ---------------- API key + backend helpers ---------------- */
  function getKey() {
    try {
      return localStorage.getItem("cfg::openaiKey") || "";
    } catch (e) {
      return "";
    }
  }
  function setKey(k) {
    try {
      if (k) localStorage.setItem("cfg::openaiKey", k);
      else localStorage.removeItem("cfg::openaiKey");
    } catch (e) {}
  }
  function getBackend() {
    try {
      return (localStorage.getItem("cfg::backendUrl") || "").trim();
    } catch (e) {
      return "";
    }
  }
  function setBackend(u) {
    try {
      if (u) localStorage.setItem("cfg::backendUrl", u);
      else localStorage.removeItem("cfg::backendUrl");
    } catch (e) {}
  }
  function getObsidian() {
    try {
      return (localStorage.getItem("cfg::obsidianUrl") || "").trim();
    } catch (e) {
      return "";
    }
  }
  function setObsidian(u) {
    try {
      if (u) localStorage.setItem("cfg::obsidianUrl", u.replace(/\/$/, ""));
      else localStorage.removeItem("cfg::obsidianUrl");
    } catch (e) {}
  }

  /* On first run, default to the subscription backend so the app works out of
   * the box (no manual settings). Seeded only once, so a user who later
   * switches to demo or an API key keeps their choice. */
  try {
    if (localStorage.getItem("cfg::seeded") !== "1") {
      if (!getBackend() && !getKey()) {
        setBackend("https://noteapi.cheetsheet.tech/generate");
      }
      localStorage.setItem("cfg::seeded", "1");
    }
  } catch (e) {}

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

  function openAITextFromResponse(data) {
    if (data && typeof data.output_text === "string") return data.output_text;
    var chunks = [];
    var output = (data && data.output) || [];
    for (var i = 0; i < output.length; i++) {
      var content = output[i].content || [];
      for (var j = 0; j < content.length; j++) {
        if (typeof content[j].text === "string") chunks.push(content[j].text);
        else if (typeof content[j].output_text === "string") chunks.push(content[j].output_text);
      }
    }
    return chunks.join("\n").trim();
  }

  /* ---------------- fetch override ---------------- */
  var realFetch = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    opts = opts || {};
    var u = typeof url === "string" ? url : (url && url.url) || "";
    // The React artifact still emits the old messages endpoint; intercept it
    // here and route the request to the configured ChatGPT/OpenAI path.
    if (u.indexOf("api.anthropic.com") !== -1) {
      var backend = getBackend();
      var key = getKey();
      var body = {};
      try {
        body = JSON.parse(opts.body);
      } catch (e) {}
      var sysP = body.system || "";
      var userP =
        (body.messages && body.messages[0] && body.messages[0].content) || "";

      // 1) BACKEND mode - uses ChatGPT/OpenAI via your server.
      //    The backend now REQUIRES auth on /generate, so attach the login token.
      if (backend) {
        var noteToken = "";
        try {
          noteToken = localStorage.getItem("cfg::noteToken") || "";
        } catch (e) {}
        var bHeaders = { "content-type": "application/json" };
        if (noteToken) bHeaders["authorization"] = "Bearer " + noteToken;
        return realFetch(backend, {
          method: "POST",
          headers: bHeaders,
          body: JSON.stringify({ system: sysP, user: userP }),
        });
      }

      // 2) API-KEY mode — direct call with the user's key.
      if (key) {
        return realFetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            authorization: "Bearer " + key,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-5.5",
            instructions: sysP,
            input: userP,
            max_output_tokens: body.max_tokens || 2000,
            store: false,
          }),
        }).then(function (resp) {
          return resp.text().then(function (txt) {
            var data = null;
            try {
              data = txt ? JSON.parse(txt) : null;
            } catch (e) {}
            if (!resp.ok) {
              return new Response(txt || JSON.stringify({ error: "OpenAI request failed" }), {
                status: resp.status,
                headers: { "Content-Type": "application/json" },
              });
            }
            var text = openAITextFromResponse(data);
            return new Response(
              JSON.stringify({ content: [{ type: "text", text: text }] }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          });
        });
      }

      // 3) DEMO mode — built-in sample responses, fully offline.
      return delay(800).then(function () {
        return jsonResp(demoFor(sysP, userP));
      });
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
      var backend = getBackend();
      var obsidian = getObsidian();
      var mode = backend
        ? "Using ChatGPT/OpenAI backend."
        : key
        ? "Using your OpenAI API key."
        : "Currently running in demo mode.";
      if (backend) mode = "Using ChatGPT/OpenAI backend.";
      else if (key) mode = "Using your OpenAI API key.";
      card.innerHTML =
        '<h3 style="margin:0 0 8px;font-size:16px;font-weight:700;">AI Settings</h3>' +
        '<p style="margin:0 0 6px;font-size:12px;color:#555;line-height:1.4;">' +
        "Choose how the app writes notes. Both fields are stored only on this device." +
        "</p>" +
        '<label style="font-size:11px;font-weight:600;color:#374151;">Backend URL - uses ChatGPT/OpenAI on your server (recommended)</label>' +
        '<input id="ck_backend" type="text" placeholder="https://noteapi.cheetsheet.tech/generate" value="' +
        (backend ? backend.replace(/"/g, "&quot;") : "") +
        '" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #ccc;border-radius:8px;font-size:13px;margin:4px 0 10px;"/>' +
        '<label style="font-size:11px;font-weight:600;color:#374151;">or OpenAI API key (pay-as-you-go)</label>' +
        '<input id="ck_key" type="password" placeholder="sk-..." value="' +
        (key ? key.replace(/"/g, "&quot;") : "") +
        '" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #ccc;border-radius:8px;font-size:13px;margin:4px 0 6px;"/>' +
        '<p style="margin:0 0 12px;font-size:11px;color:' +
        (backend || key ? "#16a34a" : "#6b7280") +
        ';">' +
        mode +
        " (If Backend URL is set, it takes priority; blank both = demo.)</p>" +
        '<label style="font-size:11px;font-weight:600;color:#374151;">Obsidian Bridge URL - optional local memory (see obsidian-bridge/)</label>' +
        '<input id="ck_obsidian" type="text" placeholder="http://localhost:8791" value="' +
        (obsidian ? obsidian.replace(/"/g, "&quot;") : "") +
        '" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #ccc;border-radius:8px;font-size:13px;margin:4px 0 6px;"/>' +
        '<p style="margin:0 0 12px;font-size:11px;color:' +
        (obsidian ? "#16a34a" : "#6b7280") +
        ';">' +
        (obsidian
          ? "Notes and lessons are also saved into your local Obsidian vault."
          : "Not connected — leave blank if you don't run obsidian-bridge.") +
        "</p>" +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
        '<button id="ck_save" style="flex:1 1 45%;padding:8px;border:none;border-radius:8px;background:#2563eb;color:#fff;font-weight:600;cursor:pointer;">Save</button>' +
        '<button id="ck_local" style="flex:1 1 45%;padding:8px;border:none;border-radius:8px;background:#111827;color:#fff;font-weight:600;cursor:pointer;">Local ChatGPT</button>' +
        '<button id="ck_clear" style="flex:1 1 45%;padding:8px;border:none;border-radius:8px;background:#f3f4f6;color:#374151;cursor:pointer;">Use demo</button>' +
        '<button id="ck_close" style="flex:1 1 45%;padding:8px;border:none;border-radius:8px;background:#f3f4f6;color:#374151;cursor:pointer;">Cancel</button>' +
        "</div>";
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      overlay.addEventListener("click", function (e) {
        if (e.target === overlay) document.body.removeChild(overlay);
      });
      card.querySelector("#ck_save").onclick = function () {
        setBackend(card.querySelector("#ck_backend").value.trim());
        setKey(card.querySelector("#ck_key").value.trim());
        setObsidian(card.querySelector("#ck_obsidian").value.trim());
        location.reload();
      };
      card.querySelector("#ck_local").onclick = function () {
        setBackend("http://localhost:8790/generate");
        setKey("");
        location.reload();
      };
      card.querySelector("#ck_clear").onclick = function () {
        setBackend("");
        setKey("");
        setObsidian("");
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
