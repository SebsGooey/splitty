"use strict";

// This fictional example lives only in memory. It never creates a BillRoom,
// opens a payment link, stores a name, or contacts an API.
function createDemoBill() {
  return {
    restaurant: "Maple Table",
    people: [
      { id: "alex", name: "Alex", color: "#8b4736" },
      { id: "sam", name: "Sam", color: "#275994" },
      { id: "jules", name: "Jules", color: "#356345" },
    ],
    items: [
      { id: "pasta", name: "Rigatoni", qty: 1, priceCents: 1600 },
      { id: "tacos", name: "Roasted veggie tacos", qty: 1, priceCents: 1450 },
      { id: "bowl", name: "Crispy tofu bowl", qty: 1, priceCents: 1350 },
      { id: "fries", name: "Truffle fries", qty: 1, priceCents: 899 },
      { id: "lemonade", name: "Lemonade pitcher", qty: 1, priceCents: 699 },
    ],
    taxCents: 480,
    tip: { mode: "percent", value: 20 },
    claims: {},
  };
}

// Explicit desired state makes a repeated claim safe: one person never gets
// counted twice. The same money.js allocation used by real bills does the rest.
function setDemoClaim(bill, personId, itemId, claimed) {
  if (!bill.people.some((person) => person.id === personId) || !bill.items.some((item) => item.id === itemId)) return false;
  const wanted = Boolean(claimed);
  if (Boolean(bill.claims[itemId]?.[personId]) === wanted) return false;
  if (wanted) {
    bill.claims[itemId] ||= {};
    bill.claims[itemId][personId] = 1;
  } else {
    delete bill.claims[itemId][personId];
    if (!Object.keys(bill.claims[itemId]).length) delete bill.claims[itemId];
  }
  return true;
}

(() => {
  const $ = (id) => document.getElementById(id);
  const format = (cents) => "$" + (cents / 100).toFixed(2);
  const bill = createDemoBill();
  let selected = "alex";
  const peopleButtons = new Map();
  const itemViews = new Map();
  const totalViews = new Map();
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };

  for (const person of bill.people) {
    const button = node("button", "chip");
    button.type = "button";
    button.dataset.personId = person.id;
    button.style.setProperty("--pc", person.color);
    button.setAttribute("aria-controls", "demoItems");
    button.setAttribute("aria-describedby", "demoPersonHelp");
    const dot = node("span", "dot");
    dot.setAttribute("aria-hidden", "true");
    button.append(dot, node("span", "", person.name));
    button.addEventListener("click", () => { selected = person.id; render("Now claiming for " + person.name + "."); });
    $("demoPeople").append(button);
    peopleButtons.set(person.id, button);

    const card = node("article", "demo-person-total");
    card.style.setProperty("--pc", person.color);
    const heading = node("h3", "", person.name);
    const amount = node("span");
    heading.append(amount);
    const items = node("p", "demo-person-items");
    const breakdown = node("dl", "demo-breakdown");
    const parts = {};
    for (const [key, label] of [["shareCents", "Items"], ["taxCents", "Tax"], ["tipCents", "Tip"]]) {
      const group = node("div");
      parts[key] = node("dd");
      group.append(node("dt", "", label), parts[key]);
      breakdown.append(group);
    }
    card.append(heading, items, breakdown);
    $("demoPersonTotals").append(card);
    totalViews.set(person.id, { amount, items, parts });
  }

  for (const item of bill.items) {
    const button = node("button", "demo-item");
    button.type = "button";
    button.dataset.itemId = item.id;
    const mark = node("span", "demo-item-mark", "+");
    mark.setAttribute("aria-hidden", "true");
    const content = node("span");
    const detail = node("span", "demo-item-detail");
    const share = node("span", "demo-item-share");
    content.append(node("span", "demo-item-name", item.name), detail, share);
    button.append(mark, content, node("span", "demo-item-price", format(item.priceCents)));
    button.addEventListener("click", () => {
      const claimed = !unitsOf(bill, item.id, selected);
      setDemoClaim(bill, selected, item.id, claimed);
      const person = bill.people.find((entry) => entry.id === selected);
      render(person.name + (claimed ? " claimed " : " removed their claim on ") + item.name + ".");
    });
    $("demoItems").append(button);
    itemViews.set(item.id, { button, mark, detail, share });
  }

  function renderGuide() {
    let title, text, next;
    if (!unitsOf(bill, "pasta", "alex")) {
      title = "1. Claim your pasta";
      next = "Try: claim Rigatoni for Alex.";
      text = selected === "alex" ? "You’re Alex. Tap Rigatoni below to claim it. Tap again to undo." : "Choose Alex, then tap Rigatoni to claim a meal for them.";
    } else if (!unitsOf(bill, "fries", "sam")) {
      title = "2. Try a shared dish";
      next = "Next: choose Sam and claim Truffle fries.";
      text = selected === "sam" ? "Tap Truffle fries to claim them for Sam. Next, Alex will join in." : "Choose Sam, then tap Truffle fries. Next, Alex will join in.";
    } else if (!unitsOf(bill, "fries", "alex")) {
      title = "3. Split the fries with Sam";
      next = "Next: choose Alex and share Truffle fries.";
      text = selected === "alex" ? "Tap Truffle fries to share them with Sam. Watch both totals change." : "Choose Alex, then tap Truffle fries too. Watch both totals change.";
    } else {
      title = "That’s how sharing works.";
      next = "You’ve shared a dish. Keep exploring!";
      text = "The fries are shared, down to the cent. Keep exploring: switch people, claim the other items, or tap again to undo.";
    }
    $("demoGuideTitle").textContent = title;
    $("demoGuideText").textContent = text;
    $("demoNextStep").textContent = next;
  }

  function render(message = "") {
    const totals = computeTotals(bill);
    const active = totals.perPerson.find((entry) => entry.person.id === selected);
    const remaining = totals.unclaimed + totals.unclaimedTax + totals.unclaimedTip;
    for (const person of bill.people) {
      const button = peopleButtons.get(person.id);
      button.setAttribute("aria-pressed", String(person.id === selected));
      button.setAttribute("aria-label", "Choose " + person.name);
      button.classList.toggle("active", person.id === selected);
    }
    for (const item of bill.items) {
      const view = itemViews.get(item.id);
      const owners = bill.people.filter((person) => unitsOf(bill, item.id, person.id));
      const mine = Boolean(unitsOf(bill, item.id, selected));
      const myShare = active.items.find((entry) => entry.item.id === item.id)?.part || 0;
      const ownerText = owners.length === 0 ? "Unclaimed" : owners.length === 1 ? "Claimed by " + owners[0].name : "Shared by " + owners.map((person) => person.name).join(", ");
      view.button.setAttribute("aria-pressed", String(mine));
      view.button.setAttribute("aria-label", `${item.name}, ${format(item.priceCents)} for the whole item. ${ownerText}. ${mine ? `Remove ${active.person.name}’s claim` : `Claim for ${active.person.name}`}.`);
      view.mark.textContent = mine ? "✓" : "+";
      view.detail.textContent = ownerText;
      view.share.textContent = mine ? active.person.name + "’s item share: " + format(myShare) : "";
      view.share.hidden = !mine;
    }
    for (const entry of totals.perPerson) {
      const view = totalViews.get(entry.person.id);
      view.amount.textContent = format(entry.totalCents);
      view.items.textContent = entry.items.length ? entry.items.map((part) => part.item.name + (part.sharers > 1 ? " (shared)" : "")).join(" · ") : "No items claimed yet";
      for (const [key, element] of Object.entries(view.parts)) element.textContent = format(entry[key]);
    }
    $("demoActiveName").textContent = active.person.name;
    $("demoActiveAmount").textContent = format(active.totalCents);
    $("demoSubtotal").textContent = format(totals.subtotal);
    $("demoTax").textContent = format(bill.taxCents);
    $("demoTip").textContent = format(totals.tipTotal);
    $("demoBillTotal").textContent = format(totals.subtotal + bill.taxCents + totals.tipTotal);
    $("demoUnclaimed").classList.toggle("complete", remaining === 0);
    $("demoUnclaimedLabel").textContent = remaining ? "Left to claim, with tax + tip" : "Everything claimed. Totals add up.";
    $("demoUnclaimedAmount").textContent = format(remaining);
    renderGuide();
    if (message) $("demoAnnouncement").textContent = `${message} ${active.person.name}’s total so far is ${format(active.totalCents)}, including tax and tip. ${remaining ? `${format(remaining)} is left to claim.` : "Everything is claimed."}`;
  }

  $("demoReset").addEventListener("click", () => {
    bill.claims = {};
    selected = "alex";
    render("Sample reset. Alex is selected and all items are unclaimed.");
  });
  render();
  $("demoInteractive").hidden = false;
})();
