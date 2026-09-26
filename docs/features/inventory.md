---
title: Inventory
summary: Item categories, market prices, value estimates, and bulk selling.
group: Features
order: 2
version: "2.1.1"
view: inventory
screenshot: docs-inventory.png
screenshotAlt: WFHelper Inventory with item categories, value estimates, filters, and owned item cards.
screenshotCaption: Inventory with sample data.
---

## Before you start

Connect an inventory source using [Getting started](/docs/getting-started#choose-an-inventory-source). You can look up public prices without a warframe.market sign-in. Creating or changing your own listings needs one.

Item counts come from your last inventory snapshot. Market prices update separately. After a trade, give the inventory time to refresh.

## Find an item

1. Open **Inventory** in the sidebar.
2. Pick a category, or use **Everything** to search across several categories. Its **Include** options choose which groups appear.
3. Type an item name in the search field. Change the sort order to compare the results.
4. Use **Filters** to narrow the list further. If an item you own seems to be missing, clear the search and any filters, then check its category.

The category tabs split the inventory into parts, relics, mods, arcanes, full sets, built equipment, pets, resources, and miscellaneous items. The equipment and resource tabs show what you own even when an item has no market price.

### Check complete sets

Open **Full Sets** to see the sets you can put together from parts you own. Turn on **Show incomplete sets** to include sets with missing parts.

A set groups parts you own. Selling a part lowers the number of complete sets you have.

## Read prices and listings

Select a market item to see its current buy and sell orders. Compare those orders with the average sale price over time before you pick a price.

- **WTS** is a seller's asking price; **WTB** is a buyer's offer.
- **R0** means unranked. Other rank labels show prices for ranked mods or arcanes.
- **Ducats** show the exchange value where there is one; not every tradable item can be exchanged for ducats.
- A missing price means there is no usable price yet.

Check the item's rank, variant, and quantity before listing it. Built equipment is not the same as the tradable blueprints or parts used to craft it.

## Understand the value estimate

**Est. value** multiplies the quantities you own by warframe.market 48-hour average sale prices. Real sale prices may differ.

- **In view** counts the items in the current view with its filters.
- **Whole inventory** counts everything in the chosen scope, not just what the view's filters show.
- **Prime parts only** counts prime parts only. **All tradables** also counts other tradable items such as mods and arcanes.
- The minimum platinum setting leaves out priced items worth less than the per-item amount you pick.

Set rows are skipped because their parts are already counted. Ducat totals count prime parts. When the total starts with **>=** and shows an **unpriced** count, some items have no price, so the total shown is incomplete. Unpriced items are still counted when you set a minimum price.

## Review what to keep

Before selling, check whether any copies of the item are reserved. Depending on your settings and goals, WFHelper can reserve copies for mastery, pinned crafting goals, full sets, spare copies, or manual locks.

Hover a reservation icon to see why copies are kept. **Safe to sell** uses your current rules and inventory snapshot; compare it with your own plans before selling.

Use **Foundry** for crafting requirements and **Mastery** for equipment you have not mastered yet.

## Select items for bulk selling

1. Open **Bulk Sell** in the inventory controls to start selecting.
2. Select the items you want, or select all eligible items in the filtered list at once.
3. If you want to use the same group again, name and save the selection.
4. Choose **Bulk sell** to review the selected items.
5. Check the proposed quantities, ranks or variants, and prices before you confirm any listings. Sign in to warframe.market when asked.

Listings are only created after you review and confirm them. Finish the trade with the buyer in Warframe.

## If something looks wrong

- **No items found:** clear the search and filters, then check another category. If every category is empty, check your inventory source in Settings.
- **A crafted blueprint still appears:** the blueprint can stay until you claim the Foundry build and a newer snapshot loads.
- **A price is missing:** let the market data finish loading and look at the current orders. Some inventory items are not tradable.
- **A set appears next to its parts:** this is a grouped view. The value estimate does not count the set twice.
- **A quantity has not changed after a trade:** see [inventory refresh and imports](/docs/getting-started#choose-an-inventory-source).

For setup and capture problems, go back to [Getting started](/docs/getting-started#if-setup-gets-stuck). If an inventory count stays wrong, report the app version, source type, item name, and the quantity you expected through [GitHub Issues](https://github.com/WFHelper/wfhelper/issues).
