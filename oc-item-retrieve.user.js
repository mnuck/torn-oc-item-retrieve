// ==UserScript==
// @name         Torn OC Item Retrieve Highlighter
// @namespace    https://github.com/mnuck/torn-oc-item-retrieve
// @version      1.4.1
// @description  Highlights Retrieve links for OC items safe to retrieve from the faction armory, and Loan buttons for items needed by faction members
// @author       mnuck
// @license      MIT; https://opensource.org/licenses/MIT
// @match        https://www.torn.com/factions.php*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @run-at       document-end
// ==/UserScript==

(function () {
  "use strict";

  // Items discovered from faction completed crimes history.
  // Map of item ID -> item name for all items that appear as OC slot requirements.
  const OC_ITEMS = new Map([
    [70,   "Polymorphic Virus"],
    [71,   "Tunneling Virus"],
    [103,  "Firewalk Virus"],
    [159,  "Bolt Cutters"],
    [172,  "Gasoline"],
    [201,  "PCP"],
    [327,  "Blank Casino Chips"],
    [568,  "Jemmy"],
    [576,  "Chloroform"],
    [579,  "Wireless Dongle"],
    [643,  "Construction Helmet"],
    [856,  "Spray Paint : Black"],
    [981,  "Wire Cutters"],
    [1012, "Blood Bag : Irradiated"],
    [1080, "Billfold"],
    [1094, "Syringe"],
    [1203, "Lockpicks"],
    [1217, "Shaving Foam"],
    [1258, "Binoculars"],
    [1331, "Hand Drill"],
    [1350, "Police Badge"],
    [1361, "Dog Treats"],
    [1362, "Net"],
    [1379, "ATM Key"],
    [1380, "RF Detector"],
    [1381, "ID Badge"],
    [1383, "DSLR Camera"],
    [1429, "Zip Ties"],
    [1430, "Shaped Charge"],
    [1431, "Core Drill"],
  ]);

  const STYLE_ID = "oc-retrieve-highlighter-style";

  // Runtime state — populated after init, exposed on window.OCItemRetrieve
  let _activeNeeds  = null;  // Map<userId, Set<itemId>>
  let _itemNeedsMap = null;  // Map<itemId, Array<{id, name}>>
  let _debug        = false;

  // ─── Logging ──────────────────────────────────────────────────────────────────

  function log(...args)  { console.log("🔵 OC Retrieve:", ...args); }
  function dbg(...args)  { if (_debug) console.log("🔧 OC Retrieve [debug]:", ...args); }

  // ─── Styles ───────────────────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .oc-retrieve-ready {
        border: 1px solid #4caf50 !important;
        border-radius: 3px !important;
        box-shadow: 0 0 8px 2px rgba(76, 175, 80, 0.6) !important;
        color: #4caf50 !important;
        padding: 1px 4px !important;
        text-shadow: 0 0 4px rgba(76, 175, 80, 0.4) !important;
      }
      .oc-loan-target {
        color: #4caf50;
        font-size: 0.85em;
        margin-left: 4px;
        font-style: italic;
      }
      #oc-missing-items-panel {
        background: #1a1a2e;
        border: 1px solid #e74c3c;
        border-radius: 4px;
        padding: 8px 12px;
        margin-bottom: 10px;
        font-size: 0.9em;
      }
      #oc-missing-items-panel h4 {
        color: #e74c3c;
        margin: 0 0 6px 0;
        font-size: 1em;
      }
      #oc-missing-items-panel ul {
        margin: 0;
        padding: 0 0 0 16px;
      }
      #oc-missing-items-panel li {
        color: #f0f0f0;
        margin: 2px 0;
      }
      #oc-missing-items-panel li a {
        color: #e74c3c;
        text-decoration: none;
      }
      #oc-missing-items-panel li a:hover {
        text-decoration: underline;
      }
    `;
    document.head.appendChild(style);
    log("styles injected");
  }

  // ─── API Key ──────────────────────────────────────────────────────────────────

  function getApiKey() {
    let key = GM_getValue("tornApiKey", "");
    if (!key) {
      key = prompt("Torn OC Item Retrieve Highlighter\n\nEnter your Torn API key (needs faction access):");
      if (key) {
        GM_setValue("tornApiKey", key.trim());
        log("API key saved");
      }
    }
    return key ? key.trim() : null;
  }

  // ─── API ──────────────────────────────────────────────────────────────────────

  function tornApiGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        onload: (response) => {
          try {
            const data = JSON.parse(response.responseText);
            if (data.error) reject(new Error(`API error: ${JSON.stringify(data.error)}`));
            else resolve(data);
          } catch (e) {
            reject(new Error(`JSON parse error: ${e.message}`));
          }
        },
        onerror: (err) => reject(new Error(`Request failed: ${err.statusText}`)),
      });
    });
  }

  async function fetchActiveCrimes(apiKey) {
    const activeNeeds  = new Map(); // userID -> Set<itemID>
    const rawItemNeeds = new Map(); // itemID -> Set<userID> (items not yet held by member)

    for (const cat of ["recruiting", "planning"]) {
      let offset = 0;
      while (true) {
        const url = `https://api.torn.com/v2/faction/crimes?key=${apiKey}&cat=${cat}&limit=100&offset=${offset}`;
        const data = await tornApiGet(url);
        const crimes = data.crimes || [];
        if (crimes.length === 0) break;

        for (const crime of crimes) {
          for (const slot of crime.slots || []) {
            const itemReq = slot.item_requirement;
            const user    = slot.user;
            if (itemReq?.id && user?.id) {
              if (!activeNeeds.has(user.id)) activeNeeds.set(user.id, new Set());
              activeNeeds.get(user.id).add(itemReq.id);

              if (itemReq.is_available === false) {
                if (!rawItemNeeds.has(itemReq.id)) rawItemNeeds.set(itemReq.id, new Set());
                rawItemNeeds.get(itemReq.id).add(user.id);
              }
            }
          }
        }

        offset += crimes.length;
        const total = data._metadata?.total || 0;
        if (total > 0 && offset >= total) break;
        if (crimes.length < 100) break;
      }
    }

    log(`${activeNeeds.size} members with active OC item needs`);
    return { activeNeeds, rawItemNeeds };
  }

  async function fetchMemberNames(apiKey) {
    const memberNames = new Map(); // userID -> name
    let offset = 0;
    while (true) {
      const url = `https://api.torn.com/v2/faction/members?key=${apiKey}&limit=100&offset=${offset}`;
      const data = await tornApiGet(url);
      const members = data.members || [];
      if (members.length === 0) break;

      for (const member of members) {
        if (member.id && member.name) memberNames.set(member.id, member.name);
      }

      offset += members.length;
      const total = data._metadata?.total || 0;
      if (total > 0 && offset >= total) break;
      if (members.length < 100) break;
    }

    log(`${memberNames.size} faction members loaded`);
    return memberNames;
  }

  function buildItemNeedsMap(rawItemNeeds, memberNames) {
    const map = new Map();
    for (const [itemId, userIds] of rawItemNeeds) {
      map.set(itemId, [...userIds].map(id => ({
        id,
        name: memberNames.get(id) || `User ${id}`,
      })));
    }
    return map;
  }

  // ─── Missing Items Panel ──────────────────────────────────────────────────────

  function renderMissingItemsPanel(missingItems) {
    const newKey  = missingItems.map(m => m.id).sort((a, b) => a - b).join(",");
    const existing = document.getElementById("oc-missing-items-panel");

    // Skip DOM write if content unchanged — prevents MutationObserver re-trigger
    if (existing && existing.dataset.missingIds === newKey) return;

    const firstRow    = document.querySelector("li:has(div.img-wrap[data-itemid])");
    const insertTarget = firstRow ? firstRow.closest("ul") : null;

    if (missingItems.length === 0) {
      if (existing) existing.remove();
      return;
    }

    const panel = existing || document.createElement("div");
    panel.id = "oc-missing-items-panel";
    panel.dataset.missingIds = newKey;

    const itemList = missingItems.map(m => {
      const count = m.needers.length;
      const noun  = count === 1 ? "person needs" : "people need";
      const url   = `https://www.torn.com/imarket.php#/p=shop&step=shop&type=&searchname=${encodeURIComponent(m.name)}`;
      return `<li><a href="${url}" target="_blank">${m.name}</a> — ${count} ${noun} it</li>`;
    }).join("");

    panel.innerHTML = `<h4>⚠ Missing Items — Need to Purchase</h4><ul>${itemList}</ul>`;

    if (!existing && insertTarget) {
      insertTarget.insertAdjacentElement("beforebegin", panel);
    }
  }

  // ─── Scan ─────────────────────────────────────────────────────────────────────
  //
  // The scan is IDEMPOTENT — safe to call any number of times. There is no
  // "already processed" row skip. Instead, each element carries its own state:
  //
  //   data-oc-handled        on loanBtn or retrieveLink — handler already attached,
  //                          annotation already added; skip setup but keep highlight.
  //   data-oc-loan-submitted on the row — user clicked Loan; skip row entirely.
  //
  // clearMarkers() removes data-oc-handled so re-attaches happen after a hash
  // change. It intentionally preserves data-oc-loan-submitted so rows where a
  // loan was already initiated stay suppressed across navigation.

  // Returns the OC item ID for the row, or null if the row is not an OC item.
  function getRowItemId(row) {
    const imgWrap = row.querySelector("div.img-wrap[data-itemid]");
    if (!imgWrap) return null;
    const itemId = parseInt(imgWrap.dataset.itemid, 10);
    if (!OC_ITEMS.has(itemId)) {
      dbg(`itemId=${itemId} — not an OC item`);
      return null;
    }
    return itemId;
  }

  // Returns the userId the item is currently loaned to, or null if available.
  function getRowLoanedUserId(row) {
    const userLink = row.querySelector("div.loaned a[href*='profiles.php']");
    if (!userLink) return null;
    const match = userLink.href.match(/XID=(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  }

  // Returns the click handler for a loan button.
  // On click: removes glow/annotation, marks row as submitted, then fills the
  // autocomplete form with "Name [ID]" (the format Torn's form validation requires).
  function makeLoanClickHandler(row, itemId, first, loanBtn) {
    return function () {
      loanBtn.classList.remove("oc-retrieve-ready");
      row.querySelector(".oc-loan-target")?.remove();
      row.dataset.ocLoanSubmitted = "1";
      log(`loan clicked — item: ${OC_ITEMS.get(itemId)} (${itemId}), filling for ${first.name} [${first.id}]`);

      const fillForm = function () {
        // Find the visible autocomplete input in this row (non-zero width)
        const allInps = row.querySelectorAll("input.ac-search[name='user']");
        let visibleInput = null;
        for (const inp of allInps) {
          if (inp.getBoundingClientRect().width > 0) { visibleInput = inp; break; }
        }
        if (!visibleInput) {
          log("fillForm: no visible input found — form may not have activated yet");
          return;
        }

        const fillValue = `${first.name} [${first.id}]`;
        visibleInput.value = fillValue;
        dbg(`fillForm: set value = "${fillValue}"`);

        // Re-apply if jQuery UI clears on focus
        visibleInput.addEventListener("focusin", function () {
          setTimeout(function () {
            if (visibleInput.value === "") visibleInput.value = fillValue;
          }, 0);
        }, { once: true });

        // Create/update hidden backing field used by Torn's form submission
        let hiddenInput = row.querySelector("input[type='hidden'][name='user']");
        if (!hiddenInput) {
          hiddenInput = document.createElement("input");
          hiddenInput.type = "hidden";
          hiddenInput.name = "user";
          visibleInput.insertAdjacentElement("afterend", hiddenInput);
        }
        hiddenInput.value = fillValue;
      };

      setTimeout(fillForm, 0);
      setTimeout(fillForm, 300);
    };
  }

  // Handles an available row: glows the loan button and annotates it with
  // the names of members who need this item. Increments stats.loanSuggested
  // the first time the button is set up (data-oc-handled not yet set).
  function processAvailableRow(row, itemId, itemNeedsMap, loanBtn, stats) {
    if (!loanBtn || !itemNeedsMap || !itemNeedsMap.has(itemId)) {
      dbg(`itemId=${itemId} (${OC_ITEMS.get(itemId)}) — available, no one needs a loan`);
      return;
    }

    const needers = itemNeedsMap.get(itemId); // Array<{id, name}>
    const first   = needers[0];

    loanBtn.classList.add("oc-retrieve-ready"); // idempotent

    if (!loanBtn.dataset.ocHandled) {
      loanBtn.dataset.ocHandled = "1";
      stats.loanSuggested++;

      const tag = document.createElement("span");
      tag.className   = "oc-loan-target";
      tag.textContent = " \u2192 " + needers.map(n => n.name).join(", ");
      loanBtn.insertAdjacentElement("afterend", tag);

      loanBtn.addEventListener("click", makeLoanClickHandler(row, itemId, first, loanBtn), { once: true });

      dbg(`itemId=${itemId} (${OC_ITEMS.get(itemId)}) — loan button set up for: ${needers.map(n => n.name).join(", ")}`);
    } else {
      dbg(`itemId=${itemId} (${OC_ITEMS.get(itemId)}) — loan handler already attached, glow reapplied`);
    }
  }

  // Handles a loaned row: highlights the Retrieve link if the holder no longer
  // needs the item for an active OC. Increments stats.checked always;
  // increments stats.highlighted the first time the link is flagged.
  function processLoanedRow(row, itemId, userId, activeNeeds, stats) {
    stats.checked++;

    const userNeeds       = activeNeeds.get(userId);
    const currentlyNeeded = userNeeds && userNeeds.has(itemId);

    if (currentlyNeeded) {
      dbg(`itemId=${itemId} (${OC_ITEMS.get(itemId)}) loaned to userId=${userId} — still needed, no retrieve`);
      return;
    }

    const retrieveLink = row.querySelector("a.retrieve.active[data-role='retrieve']");
    if (!retrieveLink) return;

    retrieveLink.classList.add("oc-retrieve-ready"); // idempotent

    if (!retrieveLink.dataset.ocHandled) {
      retrieveLink.dataset.ocHandled = "1";
      stats.highlighted++;
      dbg(`itemId=${itemId} (${OC_ITEMS.get(itemId)}) loaned to userId=${userId} — OC done, safe to retrieve`);
    }
  }

  // Coordinator: classifies each armory row and routes it to the appropriate
  // processor. Updates the missing items panel and logs aggregate stats.
  function scanArmoryRows(activeNeeds, itemNeedsMap) {
    const rows          = document.querySelectorAll("li:has(div.img-wrap[data-itemid])");
    const inArmoryItems = new Set();
    const stats         = { checked: 0, highlighted: 0, loanSuggested: 0 };

    for (const row of rows) {
      if (row.dataset.ocLoanSubmitted) {
        dbg("skip — loan already submitted for this row");
        continue;
      }

      const itemId = getRowItemId(row);
      if (itemId === null) continue;

      inArmoryItems.add(itemId);

      const userId = getRowLoanedUserId(row);
      if (userId === null) {
        const loanBtn = row.querySelector("a.loan.active[data-role='loan']");
        processAvailableRow(row, itemId, itemNeedsMap, loanBtn, stats);
      } else {
        processLoanedRow(row, itemId, userId, activeNeeds, stats);
      }
    }

    // Panel: items needed by OC members that the faction has no stock of
    if (itemNeedsMap) {
      const missingItems = [...itemNeedsMap.entries()]
        .filter(([id]) => !inArmoryItems.has(id))
        .map(([id, needers]) => ({ id, name: OC_ITEMS.get(id) || `Item ${id}`, needers }))
        .sort((a, b) => a.name.localeCompare(b.name));
      renderMissingItemsPanel(missingItems);
    }

    const { checked, highlighted, loanSuggested } = stats;
    if (checked > 0 || loanSuggested > 0 || highlighted > 0) {
      log(`scan — ${checked} loaned OC items checked, ${highlighted} flagged for retrieve, ${loanSuggested} loan suggestions`);
    }
  }

  // ─── Markers ──────────────────────────────────────────────────────────────────

  function clearMarkers() {
    document.querySelectorAll(".oc-retrieve-ready").forEach(el => el.classList.remove("oc-retrieve-ready"));
    document.querySelectorAll(".oc-loan-target").forEach(el => el.remove());
    document.getElementById("oc-missing-items-panel")?.remove();
    // Clear per-element handler flags so next scan re-attaches cleanly
    document.querySelectorAll("[data-oc-handled]").forEach(el => delete el.dataset.ocHandled);
    // Intentionally NOT clearing data-oc-loan-submitted — already-loaned rows
    // stay suppressed across tab navigation.
  }

  // ─── Debounced Scan ───────────────────────────────────────────────────────────

  let scanTimeout = null;
  function debouncedScan(activeNeeds, itemNeedsMap) {
    if (scanTimeout) clearTimeout(scanTimeout);
    scanTimeout = setTimeout(() => scanArmoryRows(activeNeeds, itemNeedsMap), 500);
  }

  // ─── Main ─────────────────────────────────────────────────────────────────────

  async function main() {
    if (!window.location.hash.includes("armoury")) {
      window.addEventListener("hashchange", () => {
        if (window.location.hash.includes("armoury")) main();
      });
      return;
    }

    log("starting");
    injectStyles();

    const apiKey = getApiKey();
    if (!apiKey) {
      console.error("❌ OC Retrieve: no API key, aborting");
      return;
    }

    let rawItemNeeds, memberNames;
    try {
      [{ activeNeeds: _activeNeeds, rawItemNeeds }, memberNames] = await Promise.all([
        fetchActiveCrimes(apiKey),
        fetchMemberNames(apiKey),
      ]);
    } catch (err) {
      console.error("❌ OC Retrieve: failed to fetch data:", err);
      return;
    }

    _itemNeedsMap = buildItemNeedsMap(rawItemNeeds, memberNames);

    scanArmoryRows(_activeNeeds, _itemNeedsMap);

    const observer = new MutationObserver(() => debouncedScan(_activeNeeds, _itemNeedsMap));
    observer.observe(document.body, { childList: true, subtree: true });

    window.addEventListener("hashchange", () => {
      if (window.location.hash.includes("armoury")) {
        clearMarkers();
        debouncedScan(_activeNeeds, _itemNeedsMap);
      }
    });

    log("watching for DOM changes");
  }

  // ─── Debug Surface ────────────────────────────────────────────────────────────

  window.OCItemRetrieve = {
    // Static data
    OC_ITEMS,

    // Live API data (available after page load completes)
    get activeNeeds()  { return _activeNeeds; },
    get itemNeedsMap() { return _itemNeedsMap; },

    // Toggle verbose per-row logging: OCItemRetrieve.debug = true
    get debug() { return _debug; },
    set debug(v) { _debug = !!v; log(`debug mode ${_debug ? "ON" : "OFF"}`); },

    // Re-run scan without touching existing state
    rescan() {
      if (!_activeNeeds) { console.warn("OC Retrieve: not initialized yet"); return; }
      scanArmoryRows(_activeNeeds, _itemNeedsMap);
    },

    // Clear visual highlights + handler flags, then re-scan.
    // Preserves data-oc-loan-submitted (already-loaned rows stay hidden).
    refresh() {
      clearMarkers();
      if (_activeNeeds) scanArmoryRows(_activeNeeds, _itemNeedsMap);
    },

    // Nuclear reset — clears everything including loan-submitted flags.
    // Use after manually retrieving a loaned item to get a clean view.
    hardReset() {
      clearMarkers();
      document.querySelectorAll("[data-oc-loan-submitted]")
        .forEach(el => delete el.dataset.ocLoanSubmitted);
      if (_activeNeeds) scanArmoryRows(_activeNeeds, _itemNeedsMap);
    },

    // Dump full diagnostic for row N (0-indexed) to the console.
    // OCItemRetrieve.inspectRow(0)
    inspectRow(n = 0) {
      const rows = document.querySelectorAll("li:has(div.img-wrap[data-itemid])");
      const row  = rows[n];
      if (!row) { console.warn(`OC Retrieve: no row at index ${n} (${rows.length} total)`); return; }

      const imgWrap     = row.querySelector("div.img-wrap[data-itemid]");
      const itemId      = imgWrap ? parseInt(imgWrap.dataset.itemid, 10) : null;
      const userLink    = row.querySelector("div.loaned a[href*='profiles.php']");
      const loanBtn     = row.querySelector("a.loan.active[data-role='loan']");
      const retrieveLink = row.querySelector("a.retrieve.active[data-role='retrieve']");
      const userId      = userLink?.href.match(/XID=(\d+)/)?.[1];
      const uid         = userId ? parseInt(userId, 10) : null;

      console.group(`OC Retrieve: row[${n}]`);
      console.log("itemId :", itemId, "→", OC_ITEMS.get(itemId) || "(not an OC item)");
      console.log("status :", userLink ? `loaned to userId=${uid}` : "available in armory");
      console.log("loanSubmitted:", !!row.dataset.ocLoanSubmitted);
      if (loanBtn) {
        console.log("loanBtn:", { handled: !!loanBtn.dataset.ocHandled, glowing: loanBtn.classList.contains("oc-retrieve-ready") });
      }
      if (retrieveLink) {
        console.log("retrieveLink:", { handled: !!retrieveLink.dataset.ocHandled, glowing: retrieveLink.classList.contains("oc-retrieve-ready") });
      }
      if (uid && _activeNeeds) {
        const needs = _activeNeeds.get(uid);
        console.log(`activeNeeds for userId=${uid}:`, needs ? [...needs].map(id => `${id} (${OC_ITEMS.get(id)})`) : "none");
        console.log("currentlyNeeded:", !!(needs?.has(itemId)));
      }
      if (itemId && _itemNeedsMap) {
        const needers = _itemNeedsMap.get(itemId);
        console.log("needers for this item:", needers?.map(n => `${n.name} [${n.id}]`) || "none");
      }
      console.groupEnd();
    },

    // Quick summary of all OC item rows — spot unexpected state at a glance.
    // OCItemRetrieve.inspectAll()
    inspectAll() {
      const rows = document.querySelectorAll("li:has(div.img-wrap[data-itemid])");
      console.group(`OC Retrieve: all ${rows.length} OC item rows`);
      rows.forEach((row, i) => {
        const iw          = row.querySelector("div.img-wrap[data-itemid]");
        const itemId      = iw ? parseInt(iw.dataset.itemid, 10) : null;
        const userLink    = row.querySelector("div.loaned a[href*='profiles.php']");
        const uid         = userLink?.href.match(/XID=(\d+)/)?.[1];
        const loanBtn     = row.querySelector("a.loan.active[data-role='loan']");
        const retrieveLink = row.querySelector("a.retrieve.active[data-role='retrieve']");
        const flags = [
          row.dataset.ocLoanSubmitted ? "LOAN_SUBMITTED" : "",
          loanBtn?.classList.contains("oc-retrieve-ready") ? "LOAN_GLOW" : "",
          retrieveLink?.classList.contains("oc-retrieve-ready") ? "RETRIEVE_GLOW" : "",
        ].filter(Boolean).join(" ");
        console.log(`[${i}]`, OC_ITEMS.get(itemId) || `id=${itemId}`, userLink ? `loaned→${uid}` : "available", flags || "(no flags)");
      });
      console.groupEnd();
    },

    // Low-level helpers for manual re-fetch from console
    getApiKey,
    fetchActiveCrimes,
    fetchMemberNames,
    buildItemNeedsMap,
    clearMarkers,
  };

  main();
})();
