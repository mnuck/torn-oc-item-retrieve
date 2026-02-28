# Torn OC Item Retrieve Highlighter

Tampermonkey userscript for [Torn City](https://www.torn.com) that highlights faction armory items safe to retrieve after an organized crime completes.

## The Problem

Faction members borrow items from the armory for organized crimes. After the OC finishes, there's no visual cue that the item can be retrieved and loaned to someone else.

## What It Does

Adds a green glow to the **Retrieve** link on the armory utilities page for OC items held by members who don't currently need them for a planning OC.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) browser extension
2. Create a new userscript and paste the contents of `oc-item-retrieve.user.js`
3. Navigate to your faction armory utilities page
4. Enter your Torn API key when prompted (needs faction access)

## API Key

The script needs a Torn API key with faction access to read planning crimes. The key is stored locally in Tampermonkey's storage and only sent to `api.torn.com`.

To reset your API key, open the browser console and run:

```js
GM_setValue('tornApiKey', '')
```

Then reload the page.

## Debugging

Open browser console — the script logs with `OC Retrieve:` prefix. Use `window.OCItemRetrieve` for manual inspection.
