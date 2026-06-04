// ==UserScript==
// @name         Torn OC Item Retrieve Highlighter
// @namespace    https://github.com/mnuck/torn-oc-item-retrieve
// @updateURL    https://github.com/mnuck/torn-oc-item-retrieve/raw/refs/heads/main/oc-item-retrieve.user.js
// @downloadURL  https://github.com/mnuck/torn-oc-item-retrieve/raw/refs/heads/main/oc-item-retrieve.user.js
// @version      1.7.2
// @description  Highlights Retrieve links for OC items safe to retrieve from the faction armory, and Loan buttons for items needed by faction members
// @author       mnuck
// @license      MIT; https://opensource.org/licenses/MIT
// @match        https://www.torn.com/factions.php*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-end
// ==/UserScript==

(function () {
  "use strict";

  // Items discovered from faction completed crimes history.
  // Map of item ID -> item name for all items that appear as OC slot requirements.
  // Also updated dynamically from scraped planning crimes data.
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
    [980,  "Ladder"],
    [981,  "Wire Cutters"],
    [1012, "Blood Bag : Irradiated"],
    [1080, "Billfold"],
    [1094, "Syringe"],
    [1203, "Lockpicks"],
    [1217, "Shaving Foam"],
    [1258, "Binoculars"],
    [1259, "Razor Wire"],
    [1277, "Floor Cleaner"],
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
    [1509, "Angle Grinder"],
    [1096, "Cell Phone"],
    [1313, "Cassock"],
  ]);

  // OC items that do NOT live in the Utilities tab. Maps item ID -> armory
  // sub-tab id (the `sub=` value in the page hash). Anything not listed is
  // assumed to be in Utilities. Used to cue the user to the right tab and to
  // distinguish "available on another tab" from "truly missing — need to buy".
  const OC_ITEM_OFFTAB = new Map([
    [201, "drugs"],   // PCP
    [643, "armour"],  // Construction Helmet
  ]);

  // Display labels for armory sub-tabs referenced by OC_ITEM_OFFTAB.
  const SUBTAB_LABELS = { drugs: "Drugs", armour: "Armor" };

  const STYLE_ID       = "oc-retrieve-highlighter-style";
  const ARMORY_ROW_SEL = "li:has(div.img-wrap[data-itemid])";
  const CACHE_KEY      = "ocScrapedData";

  // Runtime state — populated after init, exposed on window.OCItemRetrieve
  let _activeNeeds       = null;  // Map<userId, Set<itemId>>
  let _itemNeedsMap      = null;  // Map<itemId, Array<{id, name}>>
  let _seenArmoryItems   = new Set(); // OC item IDs observed available in armory this session
  let _debug             = false;
  let _armoryInitialized = false;
  let _scraperStarted    = false;

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
        text-shadow: 0 0 4px rgba(76, 175, 80, 0.4) !important;
      }
      [data-oc-tooltip] {
        position: relative;
      }
      [data-oc-tooltip]::after {
        content: attr(data-oc-tooltip);
        position: absolute;
        bottom: calc(100% + 6px);
        left: 50%;
        transform: translateX(-50%);
        background: #1a1a2e;
        color: #4caf50;
        border: 1px solid #4caf50;
        border-radius: 4px;
        padding: 4px 8px;
        font-size: 0.8em;
        white-space: nowrap;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.15s;
        z-index: 9999;
      }
      [data-oc-tooltip]:hover::after {
        opacity: 1;
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
      #oc-missing-items-panel li a.oc-tab-cue {
        color: #f39c12;
        font-weight: bold;
      }
      #oc-no-data-notice {
        background: #1a1a2e;
        border: 1px solid #f39c12;
        border-radius: 4px;
        padding: 8px 12px;
        margin-bottom: 10px;
        font-size: 0.9em;
        color: #f0f0f0;
      }
      #oc-no-data-notice a {
        color: #f39c12;
      }
    `;
    document.head.appendChild(style);
    log("styles injected");
  }

  // ─── Scrape ───────────────────────────────────────────────────────────────────

  function setAdd(map, key, value) {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(value);
  }

  // Reads planning crime data directly from React fiber props.
  // Captures any crime wrapper that has slots with both a player and an item requirement,
  // regardless of planning state class — some fully-filled crimes lack the planning___c_GFN
  // class until they begin executing.
  // Returns { activeNeeds, itemNeedsMap, itemNames } or null if no relevant crimes found.
  function scrapePlanningCrimes() {
    const planningEls = [...document.querySelectorAll(".wrapper___tgDjk")];
    if (planningEls.length === 0) return null;

    const activeNeeds  = new Map(); // userId -> Set<itemId>  (all assigned slots)
    const itemNeedsMap = new Map(); // itemId -> Array<{id, name}>  (doesExist:false only)
    const itemNames    = new Map(); // itemId -> item name

    for (const el of planningEls) {
      const fiberKey = Object.keys(el).find(k => k.startsWith("__reactFiber"));
      if (!fiberKey) continue;
      const crime = el[fiberKey]?.return?.memoizedProps?.crime;
      if (!crime?.playerSlots) continue;

      for (const slot of crime.playerSlots) {
        const userId    = slot.player?.ID    != null ? Number(slot.player.ID)           : null;
        const itemId    = slot.requirement?.id != null ? Number(slot.requirement.id)    : null;
        const userName  = slot.player?.name;
        const itemName  = slot.requirement?.name;
        const doesExist = slot.requirement?.doesExist;
        if (!userId || !itemId) continue;

        setAdd(activeNeeds, userId, itemId);

        if (itemName) {
          itemNames.set(itemId, itemName);
          if (!OC_ITEMS.has(itemId)) OC_ITEMS.set(itemId, itemName);
        }

        // Only track as a need-to-source if the member doesn't already have the item
        if (doesExist === false) {
          if (!itemNeedsMap.has(itemId)) itemNeedsMap.set(itemId, []);
          const needers = itemNeedsMap.get(itemId);
          if (!needers.some(n => n.id === userId)) {
            needers.push({ id: userId, name: userName || `User ${userId}` });
          }
        }
      }
    }

    return { activeNeeds, itemNeedsMap, itemNames };
  }

  // ─── Cache ────────────────────────────────────────────────────────────────────

  function saveScrapedData(activeNeeds, itemNeedsMap, itemNames) {
    const data = {
      activeNeeds:  [...activeNeeds].map(([uid, items]) => [uid, [...items]]),
      itemNeedsMap: [...itemNeedsMap].map(([itemId, needers]) => [itemId, needers]),
      itemNames:    [...itemNames],
      scrapedAt:    Date.now(),
    };
    GM_setValue(CACHE_KEY, JSON.stringify(data));
    log(`saved data: ${activeNeeds.size} members with active OC item needs`);
  }

  function loadScrapedData() {
    const raw = GM_getValue(CACHE_KEY, null);
    if (!raw) return null;
    try {
      const data        = JSON.parse(raw);
      const activeNeeds  = new Map(data.activeNeeds.map(([uid, items]) => [Number(uid), new Set(items.map(Number))]));
      const itemNeedsMap = new Map(data.itemNeedsMap.map(([id, needers]) => [Number(id), needers]));
      // Restore scraped item names not already in OC_ITEMS
      for (const [id, name] of data.itemNames || []) {
        if (!OC_ITEMS.has(Number(id))) OC_ITEMS.set(Number(id), name);
      }
      return { activeNeeds, itemNeedsMap, scrapedAt: data.scrapedAt };
    } catch (e) {
      log("failed to parse cached data:", e.message);
      return null;
    }
  }

  // Re-save the current in-memory needs to the cache. Used after a loan or give
  // is initiated so the change survives a page reload — otherwise the cache
  // still lists a member who has already been handed their item, and the script
  // keeps suggesting it on any Available stack of that item.
  function persistNeeds() {
    if (!_activeNeeds || !_itemNeedsMap) return;
    const itemNames = new Map();
    const collect = id => { const n = OC_ITEMS.get(id); if (n) itemNames.set(id, n); };
    for (const items of _activeNeeds.values()) for (const id of items) collect(id);
    for (const id of _itemNeedsMap.keys()) collect(id);
    saveScrapedData(_activeNeeds, _itemNeedsMap, itemNames);
  }

  // ─── Crimes Page ──────────────────────────────────────────────────────────────

  function startCrimesScraper() {
    if (_scraperStarted) return;
    _scraperStarted = true;
    log("crimes page — watching for planning crimes");

    let scrapeTimeout = null;
    function debouncedScrape() {
      if (scrapeTimeout) clearTimeout(scrapeTimeout);
      scrapeTimeout = setTimeout(() => {
        const result = scrapePlanningCrimes();
        if (!result) return;
        const { activeNeeds, itemNeedsMap, itemNames } = result;
        saveScrapedData(activeNeeds, itemNeedsMap, itemNames);
        _activeNeeds  = activeNeeds;
        _itemNeedsMap = itemNeedsMap;
      }, 500);
    }

    const observer = new MutationObserver(debouncedScrape);
    observer.observe(document.body, { childList: true, subtree: true });
    debouncedScrape();
  }

  function renderNoDataNotice() {
    if (document.getElementById("oc-no-data-notice")) return;
    const firstRow     = document.querySelector(ARMORY_ROW_SEL);
    const insertTarget = firstRow ? firstRow.closest("ul") : null;
    if (!insertTarget) return;

    const notice = document.createElement("div");
    notice.id = "oc-no-data-notice";
    notice.innerHTML = `OC Retrieve: visit the <a href="/factions.php?step=your&type=1#/tab=crimes">Planning Crimes tab</a> first to enable highlighting.`;
    insertTarget.insertAdjacentElement("beforebegin", notice);
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

  // Returns the click handler for a loan or give button.
  // On click: removes glow/annotation, marks row as submitted, then fills the
  // autocomplete form with "Name [ID]" (the format Torn's form validation requires).
  // For give (drugs, which can't be loaned), also sets the quantity field to 1 —
  // an OC slot needs exactly one item. Note: Give transfers the item into the
  // member's inventory permanently (not retrievable), unlike Loan.
  function makeHandoutClickHandler(row, itemId, first, btn, mode) {
    return function () {
      btn.classList.remove("oc-retrieve-ready");
      delete btn.dataset.ocTooltip;
      row.dataset.ocLoanSubmitted = "1";
      log(`${mode} clicked — item: ${OC_ITEMS.get(itemId)} (${itemId}), filling for ${first.name} [${first.id}]`);

      // Remove this user from itemNeedsMap so other rows for the same item stop
      // glowing — the need is now satisfied — then re-scan, and persist so the
      // change survives a reload. The armory's Loaned column only self-corrects
      // the loaned row itself; a separate Available stack of the same item (e.g.
      // a split stack) has no Loaned entry, so without persisting it would
      // re-suggest handing the item to someone who already has it.
      if (_itemNeedsMap && _itemNeedsMap.has(itemId)) {
        const remaining = _itemNeedsMap.get(itemId).filter(n => n.id !== first.id);
        if (remaining.length === 0) {
          _itemNeedsMap.delete(itemId);
        } else {
          _itemNeedsMap.set(itemId, remaining);
        }
        persistNeeds();
        debouncedScan(_activeNeeds, _itemNeedsMap);
      }

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

        // Give forms (drugs) include a quantity field; transfer one item.
        if (mode === "give") {
          for (const qty of row.querySelectorAll("input.quantity, input[name='quantity']")) {
            qty.value = "1";
          }
        }
      };

      setTimeout(fillForm, 0);
      setTimeout(fillForm, 300);
    };
  }

  // Handles an available row: glows the hand-out button (Loan for most items,
  // Give for drugs which can't be loaned) and annotates it with the names of
  // members who need this item. Increments stats.loanSuggested the first time
  // the button is set up (data-oc-handled not yet set).
  function processHandoutRow(row, itemId, itemNeedsMap, btn, stats, mode) {
    if (!btn || !itemNeedsMap || !itemNeedsMap.has(itemId)) {
      dbg(`itemId=${itemId} (${OC_ITEMS.get(itemId)}) — available, no one needs it`);
      return;
    }

    const needers = itemNeedsMap.get(itemId); // Array<{id, name}>
    const first   = needers[0];

    btn.classList.add("oc-retrieve-ready"); // idempotent

    if (!btn.dataset.ocHandled) {
      btn.dataset.ocHandled = "1";
      stats.loanSuggested++;

      const verb = mode === "give" ? "Give to: " : "Loan to: ";
      btn.dataset.ocTooltip = verb + needers.map(n => n.name).join(", ");
      btn.addEventListener("click", makeHandoutClickHandler(row, itemId, first, btn, mode), { once: true });

      dbg(`itemId=${itemId} (${OC_ITEMS.get(itemId)}) — ${mode} button set up for: ${needers.map(n => n.name).join(", ")}`);
    } else {
      dbg(`itemId=${itemId} (${OC_ITEMS.get(itemId)}) — ${mode} handler already attached, glow reapplied`);
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

  function renderMissingItemsPanel(missingItems) {
    const newKey   = missingItems.map(m => `${m.id}:${m.loanedCount || 0}`).sort().join(",");
    const existing = document.getElementById("oc-missing-items-panel");

    if (existing && existing.dataset.missingIds === newKey) return;

    if (missingItems.length === 0) {
      if (existing) existing.remove();
      return;
    }

    const firstRow     = document.querySelector(ARMORY_ROW_SEL);
    const insertTarget = firstRow ? firstRow.closest("ul") : null;
    if (!existing && !insertTarget) return;

    const panel = existing || document.createElement("div");
    panel.id = "oc-missing-items-panel";
    panel.dataset.missingIds = newKey;

    const itemList = missingItems.map(m => {
      const count   = m.needers.length;
      const noun    = count === 1 ? "person needs" : "people need";
      const offSub  = OC_ITEM_OFFTAB.get(m.id);
      if (offSub) {
        // Available on a different armory tab — cue the user there instead of
        // sending them to the market. The link switches sub-tab via the page
        // hash, which the armory hashchange listener picks up to re-scan.
        const label = SUBTAB_LABELS[offSub] || offSub;
        const href  = `#/tab=armoury&start=0&sub=${offSub}`;
        return `<li>${m.name} — ${count} ${noun} it → <a href="${href}" class="oc-tab-cue">check the ${label} tab</a></li>`;
      }
      const url = `https://www.torn.com/page.php?sid=ItemMarket#/market/view=search&itemID=${m.id}`;
      if (m.loanedCount > 0) {
        // The faction owns copies, but every one is loaned out — none free to
        // hand over. Call it out (and still link the market, since retrieving a
        // copy back may not be possible if the holders still need them).
        const loanedNote = m.loanedCount === 1
          ? "the only copy in armory is loaned out"
          : `all ${m.loanedCount} in armory are loaned out`;
        return `<li><a href="${url}" target="_blank">${m.name}</a> — ${count} ${noun} it · ${loanedNote}</li>`;
      }
      return `<li><a href="${url}" target="_blank">${m.name}</a> — ${count} ${noun} it</li>`;
    }).join("");

    panel.innerHTML = `<h4>⚠ OC Items Needed</h4><ul>${itemList}</ul>`;
    if (!existing) insertTarget.insertAdjacentElement("beforebegin", panel);
  }

  // Coordinator: classifies each armory row and routes it to the appropriate
  // processor. Updates the missing items panel and logs aggregate stats.
  function scanArmoryRows(activeNeeds, itemNeedsMap) {
    const rows         = document.querySelectorAll(ARMORY_ROW_SEL);
    const loanedCounts = new Map(); // itemId -> # of copies currently loaned out
    const stats        = { checked: 0, highlighted: 0, loanSuggested: 0 };

    for (const row of rows) {
      if (row.dataset.ocLoanSubmitted) {
        dbg("skip — loan already submitted for this row");
        continue;
      }

      const itemId = getRowItemId(row);
      if (itemId === null) continue;

      const userId = getRowLoanedUserId(row);
      if (userId === null) {
        // Only AVAILABLE (unloaned) copies count as "seen". An item whose every
        // copy is loaned out can't be handed to whoever needs it, so it must
        // still surface as a need — not be treated as on-hand.
        _seenArmoryItems.add(itemId);

        // Prefer Loan (retrievable). Fall back to Give for items that can't be
        // loaned — e.g. drugs like PCP. Give permanently transfers the item to
        // the member's inventory; there's no retrieve.
        const loanBtn = row.querySelector("a.loan.active[data-role='loan']");
        if (loanBtn) {
          processHandoutRow(row, itemId, itemNeedsMap, loanBtn, stats, "loan");
        } else {
          const giveBtn = row.querySelector("a.give.active[data-role='give']");
          if (giveBtn) processHandoutRow(row, itemId, itemNeedsMap, giveBtn, stats, "give");
        }
      } else {
        loanedCounts.set(itemId, (loanedCounts.get(itemId) || 0) + 1);
        processLoanedRow(row, itemId, userId, activeNeeds, stats);
      }
    }

    if (itemNeedsMap) {
      const missingItems = [...itemNeedsMap.entries()]
        .filter(([id]) => !_seenArmoryItems.has(id))
        .map(([id, needers]) => ({ id, name: OC_ITEMS.get(id) || `Item ${id}`, needers, loanedCount: loanedCounts.get(id) || 0 }))
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
    document.querySelectorAll(".oc-retrieve-ready").forEach(el => {
      el.classList.remove("oc-retrieve-ready");
      delete el.dataset.ocTooltip;
    });
    document.getElementById("oc-missing-items-panel")?.remove();
    document.getElementById("oc-no-data-notice")?.remove();
    // Clear per-element handler flags so next scan re-attaches cleanly
    document.querySelectorAll("[data-oc-handled]").forEach(el => delete el.dataset.ocHandled);
    _seenArmoryItems = new Set();
    // Intentionally NOT clearing data-oc-loan-submitted — already-loaned rows
    // stay suppressed across tab navigation.
  }

  // ─── Debounced Scan ───────────────────────────────────────────────────────────

  let scanTimeout = null;
  function debouncedScan(activeNeeds, itemNeedsMap) {
    if (scanTimeout) clearTimeout(scanTimeout);
    scanTimeout = setTimeout(() => scanArmoryRows(activeNeeds, itemNeedsMap), 500);
  }

  // ─── Armory Page ──────────────────────────────────────────────────────────────

  function initArmory() {
    if (_armoryInitialized) return;
    _armoryInitialized = true;

    log("armory page detected");

    const cached = loadScrapedData();
    if (!cached) {
      log("no scraped data — visit the Planning Crimes tab first to enable highlighting");

      // Watch for the armory list to appear so we can insert the notice
      const noticeObserver = new MutationObserver(renderNoDataNotice);
      noticeObserver.observe(document.body, { childList: true, subtree: true });
      renderNoDataNotice();
      return;
    }

    const ageMinutes = Math.round((Date.now() - cached.scrapedAt) / 60000);
    if (ageMinutes > 120) {
      log(`warning: scraped data is ${ageMinutes} minutes old — consider revisiting the Planning Crimes tab`);
    } else {
      log(`loaded data (${ageMinutes}m old) for ${cached.activeNeeds.size} members with active OC item needs`);
    }

    _activeNeeds     = cached.activeNeeds;
    _itemNeedsMap    = cached.itemNeedsMap;
    _seenArmoryItems = new Set();

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

  // ─── Main ─────────────────────────────────────────────────────────────────────

  function main() {
    injectStyles();

    function onHashChange() {
      const hash = window.location.hash;
      if (hash.includes("tab=crimes")) {
        startCrimesScraper();
      } else if (hash.includes("armoury")) {
        initArmory();
      }
    }

    window.addEventListener("hashchange", onHashChange);
    onHashChange();
  }

  // ─── Debug Surface ────────────────────────────────────────────────────────────

  window.OCItemRetrieve = {
    // Static + dynamically extended item map
    OC_ITEMS,

    // Live data (available after scraping or loading from cache)
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
      const rows = document.querySelectorAll(ARMORY_ROW_SEL);
      const row  = rows[n];
      if (!row) { console.warn(`OC Retrieve: no row at index ${n} (${rows.length} total)`); return; }

      const imgWrap      = row.querySelector("div.img-wrap[data-itemid]");
      const itemId       = imgWrap ? parseInt(imgWrap.dataset.itemid, 10) : null;
      const uid          = getRowLoanedUserId(row);
      const loanBtn      = row.querySelector("a.loan.active[data-role='loan']");
      const retrieveLink = row.querySelector("a.retrieve.active[data-role='retrieve']");

      console.group(`OC Retrieve: row[${n}]`);
      console.log("itemId :", itemId, "→", OC_ITEMS.get(itemId) || "(not an OC item)");
      console.log("status :", uid !== null ? `loaned to userId=${uid}` : "available in armory");
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
      const rows = document.querySelectorAll(ARMORY_ROW_SEL);
      console.group(`OC Retrieve: all ${rows.length} OC item rows`);
      rows.forEach((row, i) => {
        const iw           = row.querySelector("div.img-wrap[data-itemid]");
        const itemId       = iw ? parseInt(iw.dataset.itemid, 10) : null;
        const uid          = getRowLoanedUserId(row);
        const loanBtn      = row.querySelector("a.loan.active[data-role='loan']");
        const retrieveLink = row.querySelector("a.retrieve.active[data-role='retrieve']");
        const flags = [
          row.dataset.ocLoanSubmitted ? "LOAN_SUBMITTED" : "",
          loanBtn?.classList.contains("oc-retrieve-ready") ? "LOAN_GLOW" : "",
          retrieveLink?.classList.contains("oc-retrieve-ready") ? "RETRIEVE_GLOW" : "",
        ].filter(Boolean).join(" ");
        console.log(`[${i}]`, OC_ITEMS.get(itemId) || `id=${itemId}`, uid !== null ? `loaned→${uid}` : "available", flags || "(no flags)");
      });
      console.groupEnd();
    },

    // Low-level helpers for manual use from console
    scrapePlanningCrimes,
    saveScrapedData,
    loadScrapedData,
    clearMarkers,
  };

  main();
})();
