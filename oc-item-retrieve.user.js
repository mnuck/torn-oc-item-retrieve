// ==UserScript==
// @name         Torn OC Item Retrieve Highlighter
// @namespace    https://github.com/mnuck/torn-oc-item-retrieve
// @version      1.3.9
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
    [70, "Polymorphic Virus"],
    [71, "Tunneling Virus"],
    [103, "Firewalk Virus"],
    [159, "Bolt Cutters"],
    [172, "Gasoline"],
    [201, "PCP"],
    [327, "Blank Casino Chips"],
    [568, "Jemmy"],
    [576, "Chloroform"],
    [579, "Wireless Dongle"],
    [643, "Construction Helmet"],
    [856, "Spray Paint : Black"],
    [981, "Wire Cutters"],
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
  const MARKER_ATTR = "data-oc-retrieve-checked";

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
    console.log("🟢 OC Retrieve: styles injected");
  }

  function getApiKey() {
    let key = GM_getValue("tornApiKey", "");
    if (!key) {
      key = prompt(
        "Torn OC Item Retrieve Highlighter\n\nEnter your Torn API key (needs faction access):"
      );
      if (key) {
        GM_setValue("tornApiKey", key.trim());
        console.log("🔑 OC Retrieve: API key saved");
      }
    }
    return key ? key.trim() : null;
  }

  function tornApiGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: url,
        onload: (response) => {
          try {
            const data = JSON.parse(response.responseText);
            if (data.error) {
              reject(new Error(`API error: ${JSON.stringify(data.error)}`));
            } else {
              resolve(data);
            }
          } catch (e) {
            reject(new Error(`JSON parse error: ${e.message}`));
          }
        },
        onerror: (err) => reject(new Error(`Request failed: ${err.statusText}`)),
      });
    });
  }

  async function fetchActiveCrimes(apiKey) {
    const activeNeeds = new Map(); // userID -> Set<itemID>
    const rawItemNeeds = new Map(); // itemID -> Set<userID> (only for items not yet held)

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
            const user = slot.user;
            if (itemReq && itemReq.id && user && user.id) {
              // Track who needs what (for retrieve highlighting)
              if (!activeNeeds.has(user.id)) {
                activeNeeds.set(user.id, new Set());
              }
              activeNeeds.get(user.id).add(itemReq.id);

              // Track what items are needed but not yet held (for loan highlighting)
              if (itemReq.is_available === false) {
                if (!rawItemNeeds.has(itemReq.id)) {
                  rawItemNeeds.set(itemReq.id, new Set());
                }
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

    console.log(
      `📋 OC Retrieve: ${activeNeeds.size} members with active OC item needs`
    );
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
        if (member.id && member.name) {
          memberNames.set(member.id, member.name);
        }
      }

      offset += members.length;
      const total = data._metadata?.total || 0;
      if (total > 0 && offset >= total) break;
      if (members.length < 100) break;
    }

    console.log(`👥 OC Retrieve: ${memberNames.size} faction members loaded`);
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

  function renderMissingItemsPanel(missingItems) {
    // missingItems: Array<{id: number, name: string, needers: Array<{id, name}>}>

    // Anti-loop guard: skip DOM update if content hasn't changed
    const newKey = missingItems.map(m => m.id).sort((a, b) => a - b).join(",");
    const existing = document.getElementById("oc-missing-items-panel");
    if (existing && existing.dataset.missingIds === newKey) return;

    // Find insertion point: before the first armory items list
    const firstRow = document.querySelector("li:has(div.img-wrap[data-itemid])");
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
      const noun = count === 1 ? "person needs" : "people need";
      const searchName = encodeURIComponent(m.name);
      const marketUrl = `https://www.torn.com/imarket.php#/p=shop&step=shop&type=&searchname=${searchName}`;
      return `<li><a href="${marketUrl}" target="_blank">${m.name}</a> — ${count} ${noun} it</li>`;
    }).join("");

    panel.innerHTML = `<h4>⚠ Missing Items — Need to Purchase</h4><ul>${itemList}</ul>`;

    if (!existing && insertTarget) {
      insertTarget.insertAdjacentElement("beforebegin", panel);
    }
  }

  function scanArmoryRows(activeNeeds, itemNeedsMap) {
    const rows = document.querySelectorAll("li:has(div.img-wrap[data-itemid])");

    let highlighted = 0;
    let loanSuggested = 0;
    let checked = 0;

    // Build set of ALL OC item IDs in armory regardless of marker status.
    // Must be done outside the main loop because marked rows are skipped —
    // on re-scans (MutationObserver) all rows are already marked, so building
    // inArmoryItems inside the loop would leave it empty and cause false positives.
    const inArmoryItems = new Set();
    for (const row of rows) {
      const iw = row.querySelector("div.img-wrap[data-itemid]");
      if (!iw) continue;
      const id = parseInt(iw.dataset.itemid, 10);
      if (OC_ITEMS.has(id)) inArmoryItems.add(id);
    }

    for (const row of rows) {
      if (row.hasAttribute(MARKER_ATTR)) continue;
      if (row.hasAttribute("data-oc-loan-submitted")) continue;
      row.setAttribute(MARKER_ATTR, "1");

      const imgWrap = row.querySelector("div.img-wrap[data-itemid]");
      if (!imgWrap) continue;
      const itemId = parseInt(imgWrap.dataset.itemid, 10);
      if (!OC_ITEMS.has(itemId)) continue;

      const userLink = row.querySelector("div.loaned a[href*='profiles.php']");

      if (!userLink) {
        // Available (not loaned out) — check if anyone needs this item
        const loanBtn = row.querySelector("a.loan.active[data-role='loan']");
        if (loanBtn && itemNeedsMap && itemNeedsMap.has(itemId)) {
          const needers = itemNeedsMap.get(itemId); // Array<{id, name}>
          const first = needers[0];

          // Highlight the loan button
          loanBtn.classList.add("oc-retrieve-ready");
          loanSuggested++;

          // Always-visible annotation showing who needs this item
          const tag = document.createElement("span");
          tag.className = "oc-loan-target";
          tag.textContent = " \u2192 " + needers.map(n => n.name).join(", ");
          loanBtn.insertAdjacentElement("afterend", tag);

          // Auto-fill on click: fill the visible autocomplete input in this row
          // with the first needing member's name, and create the hidden backing field.
          loanBtn.addEventListener("click", function() {
            // Visual cleanup
            loanBtn.classList.remove("oc-retrieve-ready");
            row.querySelector(".oc-loan-target")?.remove();
            row.setAttribute("data-oc-loan-submitted", "1");
            console.log("💚 OC Retrieve: loan clicked, row cleaned up");

            const fillForm = function() {
              // Find the visible autocomplete input in this row (non-zero width)
              const allInps = row.querySelectorAll("input.ac-search[name='user']");
              let visibleInput = null;
              for (const inp of allInps) {
                if (inp.getBoundingClientRect().width > 0) {
                  visibleInput = inp;
                  break;
                }
              }
              if (!visibleInput) return;

              // Set value — no event dispatch (that triggers jQuery UI autocomplete reset)
              // Must be "Name [ID]" format — Torn's form requires the ID suffix to validate.
              const fillValue = first.name + " [" + first.id + "]";
              visibleInput.value = fillValue;

              // Re-apply if jQuery UI clears the value on focus
              visibleInput.addEventListener("focusin", function() {
                setTimeout(function() {
                  if (visibleInput.value === "") visibleInput.value = fillValue;
                }, 0);
              }, { once: true });

              // Create/update hidden backing field (format expected by form submission)
              let hiddenInput = row.querySelector("input[type='hidden'][name='user']");
              if (!hiddenInput) {
                hiddenInput = document.createElement("input");
                hiddenInput.type = "hidden";
                hiddenInput.name = "user";
                visibleInput.insertAdjacentElement("afterend", hiddenInput);
              }
              hiddenInput.value = first.name + " [" + first.id + "]";
            };

            setTimeout(fillForm, 0);
            setTimeout(fillForm, 300);
          }, { once: true });
        }
        continue;
      }

      // Loaned out — check if safe to retrieve
      const xidMatch = userLink.href.match(/XID=(\d+)/);
      if (!xidMatch) continue;
      const userId = parseInt(xidMatch[1], 10);

      checked++;

      const userNeeds = activeNeeds.get(userId);
      const currentlyNeeded = userNeeds && userNeeds.has(itemId);

      if (!currentlyNeeded) {
        const retrieveLink = row.querySelector("a.retrieve.active[data-role='retrieve']");
        if (retrieveLink) {
          retrieveLink.classList.add("oc-retrieve-ready");
          highlighted++;
        }
      }
    }

    // Compute items needed by OC members that don't exist in the armory at all
    if (itemNeedsMap) {
      const missingItems = [];
      for (const [itemId, needers] of itemNeedsMap) {
        if (!inArmoryItems.has(itemId)) {
          missingItems.push({
            id: itemId,
            name: OC_ITEMS.get(itemId) || `Item ${itemId}`,
            needers,
          });
        }
      }
      missingItems.sort((a, b) => a.name.localeCompare(b.name));
      renderMissingItemsPanel(missingItems);
    }

    if (checked > 0 || loanSuggested > 0) {
      console.log(
        `🔍 OC Retrieve: checked ${checked} loaned OC items, highlighted ${highlighted} for retrieve, ${loanSuggested} loan suggestions`
      );
    }
  }

  function clearMarkers() {
    const marked = document.querySelectorAll(`[${MARKER_ATTR}]`);
    for (const el of marked) {
      el.removeAttribute(MARKER_ATTR);
    }
    const glowing = document.querySelectorAll(".oc-retrieve-ready");
    for (const el of glowing) {
      el.classList.remove("oc-retrieve-ready");
    }
    const tags = document.querySelectorAll(".oc-loan-target");
    for (const el of tags) {
      el.remove();
    }
    const panel = document.getElementById("oc-missing-items-panel");
    if (panel) panel.remove();
  }

  let scanTimeout = null;
  function debouncedScan(activeNeeds, itemNeedsMap) {
    if (scanTimeout) clearTimeout(scanTimeout);
    scanTimeout = setTimeout(() => {
      // Do NOT call clearMarkers() here — removing our annotation spans triggers
      // another MutationObserver fire, creating an infinite scan loop that also
      // causes Torn's JS to reinitialize the loan form and clear the autofill.
      // Already-marked rows are skipped via MARKER_ATTR; only new AJAX-added
      // rows need processing. clearMarkers is called on hash changes instead.
      scanArmoryRows(activeNeeds, itemNeedsMap);
    }, 500);
  }

  async function main() {
    // Only run on the armory tab
    if (!window.location.hash.includes("armoury")) {
      // Watch for hash changes to the armory tab
      window.addEventListener("hashchange", () => {
        if (window.location.hash.includes("armoury")) {
          main();
        }
      });
      return;
    }

    console.log("🚀 OC Retrieve: starting");
    injectStyles();

    const apiKey = getApiKey();
    if (!apiKey) {
      console.log("❌ OC Retrieve: no API key, aborting");
      return;
    }

    let activeNeeds, rawItemNeeds, memberNames;
    try {
      [{ activeNeeds, rawItemNeeds }, memberNames] = await Promise.all([
        fetchActiveCrimes(apiKey),
        fetchMemberNames(apiKey),
      ]);
    } catch (err) {
      console.error("❌ OC Retrieve: failed to fetch data:", err);
      return;
    }

    const itemNeedsMap = buildItemNeedsMap(rawItemNeeds, memberNames);

    // Initial scan
    scanArmoryRows(activeNeeds, itemNeedsMap);

    // Watch for DOM changes (pagination, tab switches, AJAX reloads)
    const observer = new MutationObserver(() => debouncedScan(activeNeeds, itemNeedsMap));
    observer.observe(document.body, { childList: true, subtree: true });

    // Also re-scan on hash changes (sub-tab navigation)
    window.addEventListener("hashchange", () => {
      if (window.location.hash.includes("armoury")) {
        clearMarkers();
        debouncedScan(activeNeeds, itemNeedsMap);
      }
    });

    console.log("👀 OC Retrieve: watching for DOM changes");
  }

  // Expose for debugging
  window.OCItemRetrieve = {
    OC_ITEMS,
    getApiKey,
    fetchActiveCrimes,
    fetchMemberNames,
    buildItemNeedsMap,
    clearMarkers,
    rescan: () => main(),
  };

  main();
})();
