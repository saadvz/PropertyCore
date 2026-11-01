// Tour Core operator setup: browser presentation only.
// Every rule, check and message comes from the setup engine through /api.

import {
  action,
  add,
  api,
  banner,
  base,
  btn,
  command,
  devBlock,
  devChip,
  downloadLink,
  el,
  enc,
  errorBox,
  field,
  go,
  input,
  lines,
  loadMeta,
  mark,
  markDirty,
  onLeave,
  runPendingSaves,
  set,
  sleep,
  state,
  stepHref,
  textarea,
  UiError,
} from "/ui.js";
import { historyRedirect, liveScreen, startVisitorDemo, tourDetailScreen, toursScreen } from "/tours.js";

const app = document.getElementById("app");
const getProperty = (id) => api("GET", `/api/properties/${enc(id)}`);

function nextHref(id, stepId) {
  const steps = state.meta.steps;
  const i = steps.findIndex((s) => s.id === stepId);
  return i + 1 < steps.length ? stepHref(id, steps[i + 1].id) : `${base(id)}/review`;
}

async function rerender() {
  const [path, query = ""] = location.hash.replace(/^#/, "").split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(query);
  state.pending = [];
  state.dirty = false;
  try {
    await loadMeta();
    document.getElementById("dev-badge").hidden = !state.meta.dev;
    let screen;
    if (parts[0] === "new") screen = await propertyStep(null);
    else if (parts[0] === "p" && parts[1]) {
      const [, id, view, step] = parts;
      if (view === "setup") screen = await setupStep(id, step ?? "property", params);
      else if (view === "readiness") screen = await readinessScreen(id);
      else if (view === "practice") screen = await practiceScreen(id);
      else if (view === "published") screen = await publishedScreen(id);
      else if (view === "history") screen = await historyRedirect(id);
      else if (view === "tours") screen = step ? await tourDetailScreen(id, step) : await toursScreen(id);
      else if (view === "live") screen = await liveScreen(id, step);
      else screen = await reviewScreen(id);
    } else screen = await landing();
    app.replaceChildren(screen);
    document.title = `Tour Core${app.querySelector("h1") ? ` - ${app.querySelector("h1").textContent}` : ""}`;
  } catch (e) {
    app.replaceChildren(
      el("h1", {}, "Something went wrong"),
      el("p", {}, e.message),
      el("div", { class: "actions" }, btn("Back to start", () => go("#/"), "primary")),
    );
  }
}

let lastHash = location.hash;
window.addEventListener("hashchange", async () => {
  if (state.dirty && !confirm("You have changes on this page that aren't saved yet. Leave anyway?")) {
    history.replaceState(null, "", lastHash || "#/");
    return;
  }
  lastHash = location.hash;
  app.replaceChildren(el("p", { class: "muted" }, "Loading..."));
  await rerender();
  window.scrollTo(0, 0);
});
window.addEventListener("tourcore:rerender", () => rerender());
rerender();

// ------------------------------------------------------------------ landing

async function landing() {
  const { properties } = await api("GET", "/api/properties");
  return el(
    "div",
    {},
    el("h1", {}, "Tour Core"),
    el("p", { class: "lead" }, "Set up and test self-guided tours for your property."),
    el("div", { class: "actions" }, btn("Set up a property", () => go("#/new"), "primary")),
    properties.length ? [el("h2", {}, "Your properties"), properties.map(propertyCard)] : null,
  );
}

function statusBadge(p) {
  return el("span", { class: `badge ${p.published ? "good" : ""}` }, p.statusLabel);
}

function propertyCard(p) {
  const actions = [];
  if (!p.saved) actions.push(btn("Continue setup", () => go(`${base(p.id)}/review`), "primary"));
  else {
    if (p.published) actions.push(btn("View property", () => go(`${base(p.id)}/published`), "primary"));
    else if (p.readinessPassed && p.practicePassed) actions.push(btn("Publish for demo", action(() => publish(p.id)), "primary"));
    if (p.activeVisitorDemo) actions.push(btn("Watch live tour", () => go(`${base(p.id)}/live/${enc(p.activeVisitorDemo)}`), "primary"));
    actions.push(btn("Start visitor demo", action(() => startVisitorDemo(p.id))));
    actions.push(btn("Edit a property", () => go(`${base(p.id)}/review`)));
    actions.push(btn("Run readiness check", () => go(`${base(p.id)}/readiness`)));
    actions.push(btn("Run a practice tour", () => go(`${base(p.id)}/practice`)));
    if (p.hasHistory) actions.push(btn("View tour history", () => go(`${base(p.id)}/tours`)));
  }
  return el(
    "div",
    { class: "card" },
    el("div", { class: "card-head" }, el("div", {}, el("h3", {}, p.name), p.address !== p.name ? el("p", { class: "muted" }, p.address) : null), statusBadge(p)),
    p.saved && p.unsavedChanges ? el("p", { class: "muted" }, `${p.save.label}.`) : null,
    p.messagingLine ? el("p", { class: "muted" }, `Visitors text ${p.messagingLine}.`) : null,
    (p.needsAttention ?? []).map((n) => el("p", { class: "form-error", role: "alert" }, n.message, devChip(n.dev?.problem))),
    devBlock(p.dev),
    el("div", { class: "actions" }, actions),
  );
}

async function publish(id) {
  const res = await api("POST", `/api/properties/${enc(id)}/publish`, {});
  if (res.published) return go(`${base(id)}/published`);
  const hrefs = { readiness: `${base(id)}/readiness`, practice: `${base(id)}/practice`, review: `${base(id)}/review` };
  app.querySelector(".banner")?.remove();
  app.prepend(
    el(
      "div",
      { class: "issues banner", role: "alert" },
      el("strong", {}, "Not ready to publish yet:"),
      res.blockers.map((b) => el("div", { class: "issue" }, el("span", {}, b.message, devChip(b.dev?.code)), btn(b.next.label, () => go(hrefs[b.next.action]), "small"))),
    ),
  );
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------ wizard

function wizardShell(data, stepId, body, onContinue) {
  const steps = state.meta.steps;
  const idx = steps.findIndex((s) => s.id === stepId);
  const id = data?.summary.id;
  body.addEventListener("input", markDirty);
  body.addEventListener("change", markDirty);
  const saveState = el(
    "p",
    { class: "save-state", role: "status", "data-state": data?.summary.save.state ?? "draft" },
    data ? data.summary.save.label : "Nothing saved yet",
  );
  /** Continue first saves anything still on screen (e.g. a suggested route); a problem keeps you here. */
  const next = action(async (ev) => {
    await runPendingSaves();
    await onContinue(ev);
  });
  const nav = el(
    "ol",
    { class: "steps", "aria-label": "Setup steps" },
    steps.map((s, i) =>
      el(
        "li",
        {},
        el(
          "button",
          { type: "button", class: s.id === stepId ? "current" : "", disabled: !id, "aria-current": s.id === stepId ? "step" : null, onclick: () => go(stepHref(id, s.id)) },
          `${i + 1}. ${s.title}`,
          data?.view.steps[i]?.issueCount ? el("span", { class: "dot", title: "Needs attention" }) : null,
        ),
      ),
    ),
    id ? el("li", {}, el("button", { type: "button", onclick: () => go(`${base(id)}/review`) }, "Review")) : null,
  );
  const back = idx > 0 ? btn("Back", () => go(stepHref(id, steps[idx - 1].id))) : btn("Back", () => go(id ? `${base(id)}/review` : "#/"));
  return el(
    "div",
    {},
    el("div", { class: "wizard-head" }, el("p", { class: "muted" }, data ? data.view.property.name : "New property"), saveState),
    nav,
    body,
    el("div", { class: "actions end" }, back, btn("Continue", next, "primary")),
  );
}

/** Problems with a button to fix each one; no button when the fix is on the page already showing. */
function issueList(issues, id, currentStep) {
  if (!issues.length) return null;
  return el(
    "div",
    { class: "issues" },
    issues.map((i) =>
      el(
        "div",
        { class: "issue" },
        el("span", {}, i.message, devChip(i.dev?.code)),
        i.fix && i.fix.step !== currentStep ? btn(i.fix.label, () => go(stepHref(id, i.fix.step, i.fix.unitId)), "small") : null,
      ),
    ),
  );
}

async function setupStep(id, stepId, params) {
  if (stepId === "property") return propertyStep(id);
  const data = await getProperty(id);
  if (stepId === "units") return unitsStep(data);
  if (stepId === "doors") return doorsStep(data);
  if (stepId === "routes") return routesStep(data, params.get("unit"));
  if (stepId === "hours") return hoursStep(data);
  if (stepId === "verification") return verificationStep(data);
  if (stepId === "services") return servicesStep(data);
  return reviewScreen(id);
}

// Property ------------------------------------------------------------------

function timezonePicker(current) {
  const zones = [...state.meta.timeZones];
  const select = el("select", {}, zones.map((z) => el("option", { value: z.id }, z.label)), el("option", { value: "__other" }, "Somewhere else (type it)"));
  const other = input({ placeholder: "e.g. Eastern or Pacific", hidden: true });
  const set = (tz) => {
    if (!tz) return;
    if (!zones.some((z) => z.id === tz)) {
      zones.push({ id: tz, label: tz });
      select.insertBefore(el("option", { value: tz }, tz), select.lastChild);
    }
    select.value = tz;
    other.hidden = true;
  };
  select.addEventListener("change", () => (other.hidden = select.value !== "__other"));
  set(current);
  return { node: el("div", {}, select, other), select, set, value: () => (select.value === "__other" ? other.value : select.value) };
}

async function propertyStep(id) {
  const data = id ? await getProperty(id) : null;
  const p = data?.view.property;
  const name = input({ value: p?.displayName ?? "", placeholder: "e.g. Hillside Apartments", autocomplete: "off" });
  const address = input({ value: p?.address ?? "", placeholder: "Street, city and state", autocomplete: "off" });
  const types = [
    ["", "Choose one"],
    ["SINGLE_FAMILY", "Single-family home"],
    ["MULTIFAMILY_HOME", "Multifamily (duplex / small building you own)"],
    ["APARTMENT_OR_CONDO", "Apartment or condo (one unit)"],
  ];
  const propertyType = el("select", { required: true }, ...types.map(([value, label]) => el("option", { value, ...(value === (p?.propertyType ?? "") ? { selected: true } : {}) }, label)));
  const tz = timezonePicker(p?.timezone);
  const tzNote = el("span", { class: "hint" });
  const facts = textarea(p?.facts.join("\n") ?? "", 'e.g. "Parking is on the street."');
  const errors = errorBox();
  let tzTouched = !!id;
  tz.select.addEventListener("change", () => (tzTouched = true));

  const suggest = async () => {
    if (tzTouched) return;
    const s = await api("POST", "/api/timezone/suggest", { address: address.value });
    tz.set(s.timezone);
    tzNote.textContent =
      s.basis === "address" ? `We guessed ${s.label} from the address. Change it if that's wrong.` : `We guessed ${s.label} from this computer's clock. Please check it.`;
  };
  address.addEventListener("change", suggest);
  if (!id) suggest();

  const save = action(async () => {
    const body = { name: name.value.trim(), address: address.value, ...(propertyType.value ? { propertyType: propertyType.value } : {}), timezone: tz.value() };
    const factList = lines(facts.value);
    let propertyId = id;
    if (!id) {
      const created = await api("POST", "/api/properties", body);
      propertyId = created.summary.id;
      if (factList.length) await command(propertyId, "setPropertyDetails", { facts: factList });
    } else {
      await command(id, "setPropertyDetails", { ...body, facts: factList });
    }
    go(nextHref(propertyId, "property"));
  }, errors);

  return wizardShell(
    data,
    "property",
    el(
      "div",
      {},
      el("h1", {}, id ? "Property details" : "Let's set up your property"),
      el("p", { class: "lead" }, "Start with the basics. You can change any of this later."),
      el("div", { class: "card" }, [
        field("Property address", address),
        field("What type of property is this?", propertyType),
        field("Property or building name (optional)", name, "Only if it has one. Visitors hear the address otherwise."),
        el("label", {}, "Timezone", tzNote, tz.node),
        field("Anything visitors often ask about the building?", facts, "Optional. One fact per line. Tour Core only ever repeats what you write here."),
        errors.node,
      ]),
    ),
    save,
  );
}

// Units ---------------------------------------------------------------------

function unitsStep(data) {
  const { view, summary } = data;
  const id = summary.id;
  const condo = view.property.propertyType === "APARTMENT_OR_CONDO";
  return wizardShell(
    data,
    "units",
    el(
      "div",
      {},
      el("h1", {}, condo ? "What's the unit number?" : "Which units can people tour?"),
      el(
        "p",
        { class: "lead" },
        condo
          ? "This is one unit in a building. Visitors hear the street address and unit number — never a made-up building name."
          : "Add each unit a visitor can tour on their own. Descriptions are optional, and only what you write is ever shared with visitors.",
      ),
      issueList(view.issues.filter((i) => i.fix?.step === "units"), id, "units"),
      view.units.map((u) => unitCard(id, u)),
      condo && view.units.length ? condoAccessCard(id, view) : null,
      !condo || view.units.length === 0 ? addUnitForm(id, view.units.length === 0, condo) : null,
    ),
    () => go(nextHref(id, "units")),
  );
}

function condoAccessCard(id, view) {
  const access = view.property.buildingAccess ?? "";
  const building = el("select", {}, 
    el("option", { value: "", ...(access ? {} : { selected: true }) }, "Choose one"),
    el("option", { value: "BUILDING_AND_UNIT", ...(access === "BUILDING_AND_UNIT" ? { selected: true } : {}) }, "I control the building entrance"),
    el("option", { value: "UNIT_ONLY", ...(access === "UNIT_ONLY" ? { selected: true } : {}) }, "I only control the unit door"),
  );
  const instructions = textarea(view.units[0]?.entryInstructions ?? "", "e.g. Use the lobby code 1234, then take the elevator to floor 4.");
  const errors = errorBox();
  const save = action(async () => {
    await command(id, "setPropertyDetails", {
      ...(building.value ? { buildingAccess: building.value } : {}),
      ...(instructions.value.trim() ? { entryInstructions: instructions.value } : { skipEntryInstructions: true }),
    });
    rerender();
  }, errors);
  return el(
    "div",
    { class: "card" },
    field("Do you control the building entrance, or only the unit door?", building),
    field("How should visitors get in and find your unit?", instructions, "Optional. Sent only after they verify who they are. Leave blank to skip."),
    errors.node,
    el("div", { class: "actions" }, btn("Save", save, "primary")),
  );
}

function unitCard(id, u) {
  const card = el("div", { class: "card" });
  const show = () =>
    set(card, 
      el(
        "div",
        { class: "card-head" },
        el(
          "div",
          {},
          el("h3", {}, u.name),
          el("p", {}, u.details.line.replace(/^.*? — /, "")),
          u.details.missing.length ? el("p", { class: "form-error" }, `Still needed: ${u.details.missing.join(", ")}. Edit to add them, or type "not provided".`) : null,
          el("p", { class: u.summary ? "" : "muted" }, u.summary || "No description yet"),
          u.facts.length ? el("ul", {}, u.facts.map((f) => el("li", {}, f))) : null,
          el("p", { class: "muted" }, `Door: ${u.door?.name ?? "not set yet"}`),
        ),
        el(
          "div",
          { class: "actions" },
          btn("Edit", edit, "small"),
          btn(
            "Remove",
            action(async () => {
              if (!confirm(`Remove ${u.name}? Its door and route will be removed too.`)) return;
              await command(id, "removeUnit", { unitId: u.id });
              rerender();
            }),
            "small",
          ),
        ),
      ),
      devBlock(u.dev),
    );
  const edit = () => {
    const name = input({ value: u.name });
    const renameDoor = el("input", { type: "checkbox", checked: true });
    const doorLine = u.doorFollowsName ? el("label", { class: "checkline", hidden: true }, renameDoor, `Also rename "${u.door.name}" to match`) : null;
    if (doorLine) name.addEventListener("input", () => (doorLine.hidden = name.value.trim() === u.name));
    const summary = input({ value: u.summary, placeholder: "e.g. One-bedroom apartment on the first floor." });
    const facts = textarea(u.facts.join("\n"), 'e.g. "Washer and dryer in the unit."');
    const details = detailInputs(u.details.inputs);
    const errors = errorBox();
    const save = action(async () => {
      if (name.value.trim() !== u.name) await command(id, "renameUnit", { unitId: u.id, name: name.value, alsoRenameDoor: !!doorLine && renameDoor.checked });
      await command(id, "setUnitDetails", { unitId: u.id, summary: summary.value, facts: lines(facts.value) });
      const values = details.values();
      if (Object.keys(values).length) await command(id, "setUnitProfile", { unitId: u.id, values });
      rerender();
    }, errors);
    set(card, 
      el("h3", {}, `Edit ${u.name}`),
      field("Unit name", name),
      doorLine,
      ...details.fields,
      field("Short description", summary, "Optional. Visitors may be told this."),
      field("Other facts visitors can ask about", facts, "Optional. One per line."),
      errors.node,
      el("div", { class: "actions" }, btn("Save", save, "primary"), btn("Cancel", show)),
    );
    name.focus();
  };
  show();
  return card;
}

// Minimum leasing information. Blank means "not answered yet"; "not provided" is an explicit answer.
const DETAIL_FIELDS = [
  ["bedrooms", "Bedrooms", 'e.g. 2, or "studio"'],
  ["bathrooms", "Bathrooms", "e.g. 1 or 1.5"],
  ["monthlyRent", "Monthly rent", "e.g. $2,200"],
  ["availability", "Available", 'e.g. now, or October 15'],
  ["squareFeet", "Square feet", "Optional"],
];

function detailInputs(current) {
  const inputs = DETAIL_FIELDS.map(([key, , placeholder]) => [key, input({ value: current[key] ?? "", placeholder })]);
  return {
    fields: [
      el("div", { class: "row" }, inputs.map(([key, box]) => field(DETAIL_FIELDS.find((f) => f[0] === key)[1], box))),
      el("p", { class: "hint" }, 'Visitors are told exactly these. If you don\'t know or don\'t want one listed, type "not provided".'),
    ],
    values: () => Object.fromEntries(inputs.map(([key, box]) => [key, box.value.trim()]).filter(([key, v]) => v && v !== (current[key] ?? ""))),
  };
}

function addUnitForm(id, open, condo) {
  const card = el("div", { class: "card" });
  const form = () => {
    const name = input({ placeholder: condo ? "e.g. 4B" : "e.g. Unit 101" });
    const summary = input({ placeholder: "e.g. One-bedroom apartment on the first floor." });
    const facts = textarea("", 'e.g. "South-facing windows."');
    const doorName = input({ placeholder: "Leave blank to use the unit name + \"Door\"" });
    const details = detailInputs({});
    const errors = errorBox();
    const addIt = async () => {
      const res = await command(id, "addUnit", { name: name.value, summary: summary.value, facts: lines(facts.value), doorName: doorName.value || undefined });
      const values = details.values();
      const typed = name.value.trim().toLowerCase();
      const added = res.view?.units.find((x) => x.name.toLowerCase() === typed || x.name.toLowerCase() === `unit ${typed}`);
      if (added && Object.keys(values).length) await command(id, "setUnitProfile", { unitId: added.id, values });
    };
    const save = action(async () => {
      await addIt();
      rerender();
    }, errors);
    // A unit typed in but not added yet is added on Continue rather than silently dropped.
    onLeave(async () => {
      if (!name.isConnected || !name.value.trim()) return;
      try {
        await addIt();
      } catch (e) {
        errors.show(e.message);
        throw new UiError(`That unit wasn't added: ${e.message}`);
      }
    });
    set(card, 
      el("h3", {}, condo ? "Add your unit" : "Add a unit"),
      field(condo ? "Unit number" : "Unit name", name),
      ...details.fields,
      field("Short description", summary, "Optional."),
      field("Other facts visitors can ask about", facts, "Optional. One per line."),
      field("What's the door to this unit called?", doorName, "Optional."),
      errors.node,
      el("div", { class: "actions" }, btn("Add unit", save, "primary"), open ? null : btn("Cancel", closed)),
    );
    name.focus();
  };
  const closed = () => set(card, btn("+ Add a unit", form));
  open ? form() : closed();
  return card;
}

// Doors ---------------------------------------------------------------------

function doorRow(id, door, extra) {
  const row = el("div", { class: "card" });
  const show = () =>
    set(row, 
      el(
        "div",
        { class: "card-head" },
        el("div", {}, el("h3", {}, door.name), el("p", { class: "muted" }, door.unitName ? `${door.kindLabel} for ${door.unitName}` : door.kindLabel), devChip(door.id)),
        el(
          "div",
          { class: "actions" },
          btn("Rename", rename, "small"),
          extra?.removable
            ? btn(
                "Remove",
                action(async () => {
                  if (!confirm(`Remove ${door.name}? Any route that uses it will need fixing.`)) return;
                  await command(id, "removeDoor", { doorId: door.id });
                  rerender();
                }),
                "small",
              )
            : null,
        ),
      ),
    );
  const rename = () => {
    const name = input({ value: door.name });
    const errors = errorBox();
    set(row, 
      field(`Rename ${door.name}`, name),
      errors.node,
      el(
        "div",
        { class: "actions" },
        btn(
          "Save",
          action(async () => {
            await command(id, "renameDoor", { doorId: door.id, name: name.value });
            rerender();
          }, errors),
          "primary",
        ),
        btn("Cancel", show),
      ),
    );
    name.focus();
  };
  show();
  return row;
}

function doorsStep(data) {
  const { view, summary } = data;
  const id = summary.id;
  const unitOnly = view.property.buildingAccess === "UNIT_ONLY";
  const entrances = view.doors.filter((d) => d.kind === "ENTRANCE");
  const main = entrances[0];
  const others = view.doors.filter((d) => d.kind === "COMMON" || (d.kind === "ENTRANCE" && d !== main));

  const entranceSection = main
    ? doorRow(id, main, { removable: false })
    : (() => {
        const name = input({ value: "Main Entrance" });
        const errors = errorBox();
        return el(
          "div",
          { class: "card" },
          field("What's the main entrance called?", name, "The door visitors use to get into the building."),
          errors.node,
          el(
            "div",
            { class: "actions" },
            btn(
              "Add entrance",
              action(async () => {
                await command(id, "addDoor", { name: name.value, kind: "ENTRANCE" });
                rerender();
              }, errors),
              "primary",
            ),
          ),
        );
      })();

  const unitDoors = view.units.map((u) => {
    const door = view.doors.find((d) => d.id === u.door?.id);
    if (door) return doorRow(id, door, { removable: false });
    const name = input({ value: `${u.name} Door` });
    const errors = errorBox();
    return el(
      "div",
      { class: "card" },
      field(`${u.name} doesn't have a door yet. What's it called?`, name),
      errors.node,
      btn(
        "Add door",
        action(async () => {
          await command(id, "addDoor", { name: name.value, kind: "UNIT", unitId: u.id });
          rerender();
        }, errors),
        "primary",
      ),
    );
  });

  const addOther = el("div", { class: "card" });
  const openAdd = () => {
    const name = input({ placeholder: "e.g. Stairwell Door" });
    const kind = el("select", {}, el("option", { value: "COMMON" }, "Hallway or shared door"), el("option", { value: "ENTRANCE" }, "Another entrance"));
    const errors = errorBox();
    set(addOther, 
      el("h3", {}, "Add another door"),
      field("Door name", name),
      field("What kind of door is it?", kind),
      errors.node,
      el(
        "div",
        { class: "actions" },
        btn(
          "Add door",
          action(async () => {
            await command(id, "addDoor", { name: name.value, kind: kind.value });
            rerender();
          }, errors),
          "primary",
        ),
        btn("Cancel", closeAdd),
      ),
    );
    name.focus();
  };
  const closeAdd = () => set(addOther, btn("+ Add another door", openAdd), el("p", { class: "hint" }, "Only needed if visitors pass through a hallway door, stairwell or second entrance."));
  closeAdd();

  return wizardShell(
    data,
    "doors",
    el(
      "div",
      {},
      el("h1", {}, "Doors"),
      el("p", { class: "lead" }, "Name the doors a visitor might use. Tour Core never opens a door itself; it asks the door system, and only for doors on the visitor's route."),
      issueList(view.issues.filter((i) => i.fix?.step === "doors"), id, "doors"),
      el("h2", {}, unitOnly ? "Building entrance" : "Main entrance"),
      unitOnly && !main
        ? el("p", { class: "muted" }, "Visitors get into the building on their own. You only control the unit door, so it isn't on the tour route.")
        : entranceSection,
      view.units.length ? [el("h2", {}, "Unit doors"), unitDoors] : null,
      el("h2", {}, "Other doors"),
      others.map((d) => doorRow(id, d, { removable: d.removable })),
      addOther,
    ),
    () => go(nextHref(id, "doors")),
  );
}

// Routes --------------------------------------------------------------------

function routeDiagram(names) {
  return el(
    "div",
    { class: "route" },
    names.map((n, i) => [i ? el("span", { class: "arrow", "aria-hidden": "true" }, "\u2193") : null, el("span", { class: "stop" }, n)]),
  );
}

function routeCard(id, u, doors, focus) {
  const card = el("div", { class: focus ? "card highlight" : "card" });
  const nameOf = (doorId) => doors.find((d) => d.id === doorId)?.name ?? "(a door that no longer exists)";
  /** The open editor's current contents, or null when the card is just showing the saved route. */
  let editing = null;
  const show = () => {
    editing = null;
    set(card, 
      el("div", { class: "card-head" }, el("h3", {}, u.name), btn(u.route ? "Change route" : "Set route", editor, "small")),
      u.route ? routeDiagram(u.route.doorNames) : el("p", { class: "muted" }, "No route yet."),
      u.route?.directions ? el("p", { class: "muted" }, `Directions: ${u.route.directions}`) : null,
      issueList(u.issues.filter((i) => i.fix?.step === "routes"), id, "routes"),
    );
  };
  // Continue saves a route that's on screen but not saved yet, but only if Tour Core says it's valid.
  onLeave(async () => {
    if (!editing) return;
    const { order, directions, errors } = editing;
    const unchanged = u.route && order.join() === u.route.doorIds.join() && directions.value === (u.route.directions ?? "");
    if (unchanged) return;
    try {
      await command(id, "setRoute", { unitId: u.id, doorIds: order, directions: directions.value, onlyIfValid: true });
    } catch (e) {
      errors.show(e.message);
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      throw new UiError(`${u.name}'s route wasn't saved: ${e.message}`);
    }
  });
  const editor = () => {
    const order = [...(u.route?.doorIds ?? u.suggestedRoute)];
    const directions = input({ value: u.route?.directions ?? "", placeholder: "e.g. straight ahead, first door on the left" });
    const errors = errorBox();
    editing = { order, directions, errors };
    const list = el("div", { class: "route-editor" });
    const picker = el("select", { "aria-label": "Door to add" });
    const move = (i, j) => {
      [order[i], order[j]] = [order[j], order[i]];
      draw();
    };
    const draw = () => {
      set(list, 
        order.length
          ? order.map((doorId, i) =>
              el(
                "div",
                { class: "stop-row" },
                el("span", {}, `${i + 1}. ${nameOf(doorId)}`),
                el("button", { type: "button", class: "small", "aria-label": "Move up", disabled: i === 0, onclick: () => move(i, i - 1) }, "\u2191"),
                el("button", { type: "button", class: "small", "aria-label": "Move down", disabled: i === order.length - 1, onclick: () => move(i, i + 1) }, "\u2193"),
                btn("Remove", () => (order.splice(i, 1), draw()), "small"),
              ),
            )
          : el("p", { class: "muted" }, "No doors yet. Start with the entrance."),
      );
      set(picker, 
        el("option", { value: "" }, "Choose a door to add..."),
        doors.filter((d) => !order.includes(d.id)).map((d) => el("option", { value: d.id }, `${d.name} (${d.kindLabel.toLowerCase()})`)),
      );
    };
    draw();
    set(card, 
      el("h3", {}, `Route for ${u.name}`),
      el("p", { class: "muted" }, u.route ? "List the doors in the order the visitor walks through them." : "We filled in a suggested route. Change it if visitors go a different way."),
      list,
      el("div", { class: "row" }, picker, btn("Add door", () => picker.value && (order.push(picker.value), draw()))),
      field("Directions from the entrance", directions, "Optional. Sent to the visitor when they come in."),
      issueList(u.issues.filter((i) => i.fix?.step === "routes"), id, "routes"),
      errors.node,
      el(
        "div",
        { class: "actions" },
        btn(
          "Save route",
          action(async () => {
            await command(id, "setRoute", { unitId: u.id, doorIds: order, directions: directions.value });
            rerender();
          }, errors),
          "primary",
        ),
        u.route ? btn("Cancel", show) : null,
      ),
    );
  };
  !u.route || focus ? editor() : show();
  if (focus) setTimeout(() => card.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  return card;
}

function routesStep(data, focusUnit) {
  const { view, summary } = data;
  const id = summary.id;
  return wizardShell(
    data,
    "routes",
    el(
      "div",
      {},
      el("h1", {}, "How does a visitor get to each unit?"),
      el("p", { class: "lead" }, "For each unit, list the doors a visitor goes through, in order. During a tour, only these doors can open, and only during the visitor's time."),
      view.units.length ? view.units.map((u) => routeCard(id, u, view.doors, u.id === focusUnit)) : el("p", { class: "muted" }, "Add a unit first."),
    ),
    () => go(nextHref(id, "routes")),
  );
}

// Tour hours ----------------------------------------------------------------

const DAYS = [["MON", "Mon"], ["TUE", "Tue"], ["WED", "Wed"], ["THU", "Thu"], ["FRI", "Fri"], ["SAT", "Sat"], ["SUN", "Sun"]];

function fmtMinutes(n, zero = "None") {
  if (n === 0) return zero;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return [h ? `${h} hour${h > 1 ? "s" : ""}` : "", m ? `${m} minutes` : ""].filter(Boolean).join(" ");
}

function minutesSelect(options, current, zero) {
  const all = [...new Set([...options, current])].sort((a, b) => a - b);
  return el("select", {}, all.map((n) => el("option", { value: String(n), selected: n === current }, fmtMinutes(n, zero))));
}

function hoursStep(data) {
  const { view, summary } = data;
  const id = summary.id;
  const th = view.tourHours;
  const boxes = DAYS.map(([code, label]) => ({ code, cb: el("input", { type: "checkbox", checked: th.days.includes(code) }), label }));
  const start = el("input", { type: "time", value: th.start });
  const end = el("input", { type: "time", value: th.end });
  const length = minutesSelect([15, 20, 30, 45, 60, 90, 120], th.tourLengthMinutes);
  const spacing = minutesSelect([15, 30, 45, 60, 90, 120, 180, 240], th.slotEveryMinutes);
  const early = minutesSelect([0, 5, 10, 15, 20, 30, 45, 60], th.earlyArrivalMinutes, "No early entry");
  const errors = errorBox();
  const preset = (days, s, e) => {
    boxes.forEach((b) => (b.cb.checked = days.includes(b.code)));
    start.value = s;
    end.value = e;
  };

  const pickedDays = () => boxes.filter((b) => b.cb.checked).map((b) => b.code);
  const initial = { days: pickedDays().join(","), start: start.value, end: end.value };
  const save = action(async () => {
    // Different hours on different days stay as they are unless the days or times here were changed.
    const timesChanged = pickedDays().join(",") !== initial.days || start.value !== initial.start || end.value !== initial.end;
    const keepWindows = (th.windows?.length ?? 0) > 1 && !timesChanged;
    const res = await command(id, "setTourHours", {
      ...(keepWindows ? {} : { days: pickedDays(), start: start.value, end: end.value }),
      tourLengthMinutes: Number(length.value),
      slotEveryMinutes: Number(spacing.value),
      earlyArrivalMinutes: Number(early.value),
    });
    const problems = res.view.issues.filter((i) => i.fix?.step === "hours");
    if (problems.length) return rerender();
    go(nextHref(id, "hours"));
  }, errors);

  return wizardShell(
    data,
    "hours",
    el(
      "div",
      {},
      el("h1", {}, "When can people tour?"),
      el("p", { class: "lead" }, th.summary ? `Right now: ${th.summary}` : "This schedule needs a fix before any tours can be offered. See below."),
      issueList(view.issues.filter((i) => i.fix?.step === "hours"), id, "hours"),
      (th.windows?.length ?? 0) > 1
        ? el("p", { class: "hint" }, "Some days have different hours. Changing the days or times below sets one set of hours for the checked days.")
        : null,
      el(
        "div",
        { class: "card" },
        el("div", { class: "actions" }, btn("Weekdays, 9 AM to 5 PM", () => preset(["MON", "TUE", "WED", "THU", "FRI"], "09:00", "17:00"), "small"), btn("Every day, 10 AM to 6 PM", () => preset(DAYS.map((d) => d[0]), "10:00", "18:00"), "small")),
        el("label", {}, "Days"),
        el("div", { class: "days" }, boxes.map((b) => el("label", { class: "day" }, b.cb, b.label))),
        el("div", { class: "row" }, field("First tour can start at", start), field("Last tour must be over by", end)),
        el("div", { class: "row" }, field("Each tour lasts", length), field("A new tour can start every", spacing)),
        field("Visitors can get in early by", early, "The doors work a little before the tour starts, in case someone arrives early."),
        errors.node,
      ),
    ),
    save,
  );
}

// Verification --------------------------------------------------------------

function verificationStep(data) {
  const { view, summary } = data;
  const id = summary.id;
  let mode = view.verification.mode;
  const days = el("input", { type: "number", min: "1", max: "365", value: String(view.verification.reuseForDays) });
  const errors = errorBox();
  const daysCard = el(
    "div",
    { class: "card", hidden: mode === "none" },
    field(
      "How many days before a visitor fills out the form again?",
      days,
      "A visitor who already filled out the form can book another tour within this many days without filling it out again.",
    ),
  );
  const confirmCard = el("div", { class: "card", hidden: true });
  const choices = view.verification.options.map((o) => {
    const radio = el("input", { type: "radio", name: "verification", value: o.mode, checked: o.mode === mode });
    const node = el(
      "label",
      { class: `choice ${o.mode === mode ? "selected" : ""}` },
      radio,
      el("div", {}, el("strong", {}, o.title), o.recommended ? [" ", el("span", { class: "badge" }, "Recommended")] : null, el("p", { class: "muted" }, o.explanation)),
    );
    radio.addEventListener("change", () => {
      mode = o.mode;
      daysCard.hidden = mode === "none";
      confirmCard.hidden = true;
      document.querySelectorAll(".choice").forEach((c) => c.classList.toggle("selected", c === node));
    });
    return node;
  });
  const saveNone = action(async () => {
    await command(id, "setVerificationPolicy", { mode: "none", confirm: true });
    go(nextHref(id, "verification"));
  }, errors);
  const keepForm = () => {
    mode = "basic-form";
    confirmCard.hidden = true;
    daysCard.hidden = false;
    document.querySelectorAll('input[name="verification"]').forEach((radio) => {
      const on = radio.value === "basic-form";
      radio.checked = on;
      radio.closest(".choice")?.classList.toggle("selected", on);
    });
  };
  set(
    confirmCard,
    el("p", {}, "Without a form, anyone who texts can book a tour and get in without telling you who they are. Want to go ahead with no form?"),
    el("div", { class: "actions" }, btn("Yes, no form", saveNone), btn("Keep the form", keepForm)),
  );
  const save = action(async () => {
    if (mode === "none") {
      if (view.verification.mode === "none") {
        go(nextHref(id, "verification"));
        return;
      }
      confirmCard.hidden = false;
      return;
    }
    await command(id, "setVerificationPolicy", { mode, reuseForDays: Number(days.value) });
    go(nextHref(id, "verification"));
  }, errors);
  return wizardShell(
    data,
    "verification",
    el(
      "div",
      {},
      el("h1", {}, "Should visitors fill out a short identity form before their tour?"),
      el("p", { class: "lead" }, "We recommend it, so you know who's coming in."),
      issueList(view.issues.filter((i) => i.fix?.step === "verification"), id, "verification"),
      choices,
      daysCard,
      confirmCard,
      errors.node,
    ),
    save,
  );
}

// Records and messages -------------------------------------------------------

/** Plain-language connection status for real messaging; account details never reach the browser. */
function messagingStatus(id) {
  const box = el("div", { class: "card" }, el("p", { class: "muted" }, "Checking visitor messaging..."));
  api("GET", `/api/properties/${enc(id)}/messaging`)
    .then((s) =>
      set(
        box,
        el("h3", {}, "Visitor messaging"),
        s.checks.map((c) => el("div", { class: "status-row" }, mark(c.ok), el("span", {}, c.message, devChip(c.dev?.code)))),
        s.line
          ? el("p", {}, `Texting number for this property: ${s.line}`)
          : s.mode === "live"
            ? el("p", { class: "muted" }, "The texting number is connected to this property when you run the readiness check.")
            : null,
        s.connected
          ? el("p", { class: "muted" }, "Visitors can text the property's number now.")
          : el("p", { class: "hint" }, "The messaging provider is connected by whoever runs this computer. Nothing needs to be typed here."),
        btn("Check again", () => rerender(), "small"),
      ),
    )
    .catch((e) => set(box, el("p", { class: "form-error" }, e.message)));
  return box;
}

function servicesStep(data) {
  const { view, summary } = data;
  const id = summary.id;
  const alertName = input({ value: view.operator.name });
  const visitorContact = input({ value: view.operator.visitorContact, inputmode: "tel", autocomplete: "tel" });
  const errors = errorBox();
  let mode = view.services.messaging.mode;
  const choices = view.services.messaging.options.map((o) => {
    const radio = el("input", { type: "radio", name: "messaging", value: o.mode, checked: o.mode === mode });
    const node = el("label", { class: `choice ${o.mode === mode ? "selected" : ""}` }, radio, el("div", {}, el("strong", {}, o.title), el("p", { class: "muted" }, o.explanation)));
    radio.addEventListener("change", async () => {
      mode = o.mode;
      await command(id, "setServices", { messagingMode: mode });
      rerender();
    });
    return node;
  });
  const save = action(async () => {
    await command(id, "setAlertContact", { name: alertName.value, visitorContact: visitorContact.value });
    go(`${base(id)}/review`);
  }, errors);
  return wizardShell(
    data,
    "services",
    el(
      "div",
      {},
      el("h1", {}, "Records, messages and doors"),
      el("p", { class: "lead" }, "Records and door access run as a safe demo. Messages can go to real phones through the connected messaging provider."),
      el("h2", {}, "How should visitors get messages?"),
      choices,
      mode === "live" ? messagingStatus(id) : null,
      el("h2", {}, "Everything else"),
      view.services.items.map((s) =>
        el("div", { class: "card" }, el("h3", {}, s.title, " ", s.demo === false ? null : el("span", { class: "badge demo" }, "Demo")), el("p", { class: "muted" }, s.text), devBlock(s.dev)),
      ),
      el(
        "div",
        { class: "card" },
        field("Who should we alert if a visitor needs help?", alertName, "Use a team name that reads naturally after \"the\", for example leasing team or Maple Leasing team."),
        field(
          "What number can stuck visitors call? Pick one someone answers during tour hours.",
          visitorContact,
          "Visitors see and call this number. Optional. Leave blank if they should reply to the text. This is not your private alert line.",
        ),
        errors.node,
      ),
    ),
    save,
  );
}

// ------------------------------------------------------------------ review

async function reviewScreen(id) {
  const { view, summary } = await getProperty(id);
  return el(
    "div",
    {},
    el("p", { class: "muted" }, "Review your setup"),
    el("h1", {}, view.property.name),
    summary.saved && summary.unsavedChanges
      ? el(
          "div",
          { class: "notice" },
          `${summary.save.label}. Your saved setup hasn't changed. `,
          btn(
            "Discard draft changes",
            action(async () => {
              if (!confirm("Discard your unsaved changes?")) return;
              await api("POST", `/api/properties/${enc(id)}/discard`, {});
              rerender();
            }),
            "link",
          ),
        )
      : null,
    view.issues.length ? [el("h2", {}, "Needs attention"), issueList(view.issues, id)] : null,
    view.reviewCards.map((card) =>
      el(
        "div",
        { class: "card" },
        el("div", { class: "card-head" }, el("h3", {}, card.title), btn("Edit", () => go(stepHref(id, card.step, card.unitId)), "small")),
        card.rows.map((r) => el("p", {}, r)),
        card.route
          ? el("div", {}, el("p", { class: "muted" }, "Route"), el("p", {}, card.route.text), btn("Edit route", () => go(stepHref(id, "routes", card.unitId)), "link"))
          : null,
      ),
    ),
    devBlock(view.dev),
    el("div", { class: "actions end" }, btn("Back to setup", () => go(stepHref(id, "property"))), btn("Run readiness check", () => go(`${base(id)}/readiness`), "primary")),
  );
}

// ------------------------------------------------------------------ readiness

function readinessList(id, r) {
  return el(
    "div",
    { class: "card" },
    el(
      "ul",
      { class: "checks" },
      r.checks.map((c) =>
        el(
          "li",
          {},
          el("div", { class: "check-line" }, mark(c.ok), el("strong", {}, c.label)),
          c.problems.map((p) =>
            el("div", { class: "problem" }, el("span", {}, p.message, devChip(p.dev?.code)), p.fix ? btn(p.fix.label, () => go(stepHref(id, p.fix.step, p.fix.unitId)), "small") : null),
          ),
        ),
      ),
      (r.advisories ?? []).map((note) => el("li", {}, el("div", { class: "check-line" }, mark(), el("span", {}, note)))),
    ),
  );
}

async function readinessScreen(id) {
  const res = await api("POST", `/api/properties/${enc(id)}/readiness`, {});
  const r = res.readiness;
  return el(
    "div",
    {},
    el("p", { class: "muted" }, res.summary.name),
    el("h1", {}, "Checking your property"),
    res.savedChanges ? el("p", { class: "muted" }, "Your changes were saved.") : null,
    readinessList(id, r),
    el("div", { class: r.passed ? "success" : "notice" }, r.headline),
    el(
      "div",
      { class: "actions end" },
      btn("Back to review", () => go(`${base(id)}/review`)),
      r.passed ? btn("Run a practice tour", () => go(`${base(id)}/practice`), "primary") : btn("Check again", () => rerender(), "primary"),
    ),
  );
}

// ------------------------------------------------------------------ practice

function checkItem(item) {
  const outcome = item.ok ? item.outcome : item.detail ?? "This didn't work as expected.";
  return el(
    "li",
    {},
    el("div", { class: "check-line" }, mark(item.ok), el("div", {}, el("strong", {}, item.label), outcome ? el("span", { class: item.ok ? "outcome" : "outcome bad" }, outcome) : null, devChip(item.dev?.id))),
  );
}

async function showPractice(container, id, p, summary) {
  const groups = p.groups.map((g) => {
    const list = el("ul", { class: "checks" });
    const box = el(
      "div",
      { class: g.id === "safety" ? "card safety" : "card" },
      el("h2", {}, g.title),
      g.id === "safety" ? el("p", { class: "muted" }, "Tour Core only asks the door system to unlock a door after its own safety checks pass.") : null,
      list,
    );
    return { g, list, box };
  });
  set(container, ...groups.map((x) => x.box));
  for (const { g, list } of groups) {
    for (const item of g.items) {
      list.append(checkItem(item));
      await sleep(140);
    }
  }
  const next = p.passed
    ? summary.published
      ? btn("View property", () => go(`${base(id)}/published`), "primary")
      : btn("Publish for demo", action(() => publish(id)), "primary")
    : btn("Back to review", () => go(`${base(id)}/review`), "primary");
  add(
    container,
    el("div", { class: p.passed ? "success" : "issues", role: "status" }, el("strong", {}, p.headline), p.failure ? el("p", {}, p.failure) : null),
    p.recordsSaved
      ? el(
          "div",
          { class: "card" },
          el("p", {}, "Tour records saved."),
          el(
            "div",
            { class: "actions" },
            btn("View records", () => go(p.tourId ? `${base(id)}/tours/${enc(p.tourId)}` : `${base(id)}/tours`)),
            downloadLink("Export records", `/api/properties/${enc(id)}/export/records.json`),
          ),
        )
      : null,
    p.messages.length
      ? el(
          "details",
          {},
          el("summary", {}, `See the ${p.messages.length} messages sent during the tour`),
          p.messages.map((m) => el("div", { class: "message" }, el("span", { class: "who" }, `${m.time} \u00b7 ${m.to}`), m.body)),
        )
      : null,
    devBlock(p.dev),
    el("div", { class: "actions" }, next, p.passed ? btn("Start visitor demo", action(() => startVisitorDemo(id))) : null, btn("Run it again", () => rerender())),
  );
}

async function practiceScreen(id) {
  const { view, summary } = await getProperty(id);
  const container = el("div", {});
  const unitSelect = view.units.length > 1 ? el("select", {}, view.units.map((u) => el("option", { value: u.id }, u.name))) : null;
  const start = action(async () => {
    const res = await api("POST", `/api/properties/${enc(id)}/practice`, { unitId: unitSelect?.value });
    if (res.readiness) {
      set(container, el("div", { class: "notice" }, "A few things need fixing before a practice tour."), readinessList(id, res.readiness));
      return;
    }
    await showPractice(container, id, res.practice, res.summary);
  });
  const unchecked = !summary.saved || summary.unsavedChanges;
  return el(
    "div",
    {},
    el("p", { class: "muted" }, summary.name),
    el("h1", {}, "Practice tour"),
    el("p", { class: "lead" }, "A pretend visitor named Pat takes a tour so you can watch every step. No real texts are sent and no real doors open."),
    unchecked
      ? el("div", { class: "notice" }, `${summary.save.label}. `, btn("Review setup", () => go(`${base(id)}/review`), "link"))
      : [unitSelect ? el("div", { class: "card" }, field("Which unit should Pat tour?", unitSelect)) : null, el("div", { class: "actions" }, btn("Start practice tour", start, "primary"))],
    container,
  );
}

// ------------------------------------------------------------------ published

async function publishedScreen(id) {
  const { summary: s } = await getProperty(id);
  if (!s.published) {
    return el(
      "div",
      {},
      el("p", { class: "muted" }, s.name),
      el("h1", {}, "Not published yet"),
      el("p", {}, "This property hasn't been published for demo yet. It needs a passed readiness check and a passed practice tour first."),
      el("div", { class: "actions" }, btn("Publish for demo", action(() => publish(id)), "primary"), btn("Back to review", () => go(`${base(id)}/review`))),
    );
  }
  return el(
    "div",
    {},
    el("p", { class: "muted" }, s.name),
    el("h1", {}, "Your property is ready for demo."),
    el("p", {}, "Status: ", el("span", { class: "badge good status-big" }, "PUBLISHED FOR DEMO")),
    el(
      "div",
      { class: "notice" },
      el("strong", {}, "This is a demo configuration."),
      el("p", {}, "No real door system is connected. Messages appear on screen, tour records stay on this computer, and door access runs in demo mode, so no real doors open."),
    ),
    devBlock(s.dev),
    el(
      "div",
      { class: "actions" },
      btn("Start visitor demo", action(() => startVisitorDemo(id)), "primary"),
      btn("View property", () => go(`${base(id)}/review`)),
      btn("Run another practice tour", () => go(`${base(id)}/practice`)),
      btn("Edit setup", () => go(stepHref(id, "property"))),
      btn("View history", () => go(`${base(id)}/tours`)),
    ),
  );
}
