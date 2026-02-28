# Torn OC Item Retrieve Highlighter

## Architecture

Single-file Tampermonkey userscript. No build step, no dependencies.

- `oc-item-retrieve.user.js` — the entire extension

## Key Concepts

- **OC_ITEMS** (line ~20): Hard-coded Map of item IDs used in organized crimes, discovered from faction completed crimes history via the Torn API. Update this when new OC types are added to the game.
- **OC_ITEM_NAME_TO_ID** (line ~55): Reverse lookup for name-based item matching as a fallback when DOM doesn't expose item IDs directly.
- **activeNeeds**: `Map<userID, Set<itemID>>` built at runtime from the `/v2/faction/crimes?cat=planning` endpoint. Represents items currently needed by members for in-progress OCs.

## DOM Interaction

Torn uses AJAX navigation — the page doesn't fully reload when switching tabs or paginating. The script uses:

- **MutationObserver** on `document.body` to detect DOM changes
- **Debounced re-scan** (500ms) to avoid excessive processing
- **Marker attribute** (`data-oc-retrieve-checked`) to avoid re-processing rows
- **Hash change listener** for armory tab navigation

### Selectors

The armory page DOM structure is not documented and may change. The script tries multiple selector strategies:

- **Item ID extraction**: data attributes → image src pattern → name matching (fallback)
- **User ID extraction**: profile link href `XID=` parameter
- **Item rows**: multiple selector patterns for robustness
- **Retrieve link**: text content match on anchor elements

If Torn changes their DOM structure, these selectors will break. Check `extractItemIdFromRow()`, `isItemLoanedOut()`, and `scanArmoryRows()` for the selector logic.

## API

- **Endpoint**: `https://api.torn.com/v2/faction/crimes?cat=planning`
- **Auth**: User's personal API key with faction access, stored via `GM_setValue`
- **Rate limiting**: Torn allows ~100 requests/minute. The script makes 1-2 requests on page load (pagination if >100 planning crimes).

## Debugging

Open browser console and use `window.OCItemRetrieve`:

```js
OCItemRetrieve.OC_ITEMS          // hard-coded item map
OCItemRetrieve.fetchPlanningCrimes(key)  // re-fetch planning data
OCItemRetrieve.clearMarkers()    // remove all highlights
OCItemRetrieve.rescan()          // full re-run
```

## Updating OC Items

When new organized crime types are added to Torn, update the `OC_ITEMS` map. Run this in the browser console to discover items from completed crimes:

```js
async function discoverOcItems(apiKey) {
  const items = new Map();
  let offset = 0;
  while (true) {
    const resp = await fetch(`https://api.torn.com/v2/faction/crimes?key=${apiKey}&cat=completed&limit=100&offset=${offset}`);
    const data = await resp.json();
    for (const crime of data.crimes || []) {
      for (const slot of crime.slots || []) {
        if (slot.item_requirement?.id) items.set(slot.item_requirement.id, crime.name);
      }
    }
    offset += (data.crimes || []).length;
    if (!data.crimes?.length || offset >= (data._metadata?.total || offset)) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log([...items.keys()].sort((a,b) => a-b));
}
```
