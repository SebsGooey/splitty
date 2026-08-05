# Splitty 🧾

Interactive bill splitter for the Moxies Miami receipt (07/31/26, Table 122, Party of 11).

**Live:** https://USERNAME.github.io/splitty/

## How it works

1. Add everyone who was at the table.
2. Tap a person's name to select them, then tap the items they had.
3. Tap an item again to un-claim it. If multiple people claim the same item, it splits evenly between them.
4. Each person's card shows their items subtotal, plus their proportional share of tax (8%) and the 20% service charge — both percentages are editable.

Everything updates live as items are claimed, and selections persist in the browser via `localStorage` (they also sync in real time across tabs on the same device).

## Receipt details

Line items were consolidated from the printed receipt (e.g. "Lime Marg $15.00" + "Add Mango Puree $1.00" → one $16.00 item) and verified to sum exactly to the printed totals:

| | |
|---|---:|
| Sub Total | $737.00 |
| Tax (8%) | $58.96 |
| Service Charge (20%) | $147.40 |
| **Total** | **$943.36** |

No build step — a single static `index.html`, hosted on GitHub Pages.
