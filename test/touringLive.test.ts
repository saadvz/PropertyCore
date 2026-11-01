import { afterEach, describe, expect, it } from "vitest";
import { standDownTouring, touringLiveWork } from "../src/hosted/touringLive";
import { at, liveApp, PHONE, type LiveApp } from "./liveApp";

/** What's live on one touring host's Tour Core, and standing it down. A real booking; Sendblue is faked. */

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean();
});

async function booked(): Promise<LiveApp> {
  const app = await liveApp({ cleanups });
  await app.book();
  return app;
}

const services = (app: LiveApp) => app.server.tourCore.services;
const now = (app: LiveApp) => new Date(app.clock.t);

describe("what's live on touring", () => {
  it("lists a published property and a booked tour, with the text the visitor would get", async () => {
    const app = await booked();
    const work = await touringLiveWork(services(app), now(app));
    expect(work.inProgress).toBe(false);
    expect(work.live).toHaveLength(2);
    expect(work.live[0]).toMatch(/is taking bookings\.$/);
    expect(work.live[1]).toMatch(/^Testy McTest's tour at 2:00 PM on /);
    expect(work.texts).toHaveLength(1);
    expect(work.texts[0]!.to).toBe("Testy McTest");
    expect(work.texts[0]!.body).toContain("cancel");
  });

  it("counts nothing for a property with no bookings that isn't published", async () => {
    const app = await liveApp({ cleanups });
    const id = app.ws.list()[0]!.config.property.id;
    app.ws.patchState(id, { paused: true });
    expect(await touringLiveWork(services(app), now(app))).toEqual({ live: [], inProgress: false, texts: [] });
  });

  it("sees someone on a tour", async () => {
    const app = await booked();
    app.clock.t = at(13, 58);
    await app.text("I'm here");
    expect((await touringLiveWork(services(app), now(app))).inProgress).toBe(true);
  });
});

describe("standing touring down", () => {
  it("pauses bookings and cancels the booked tour, texting the visitor the previewed text once", async () => {
    const app = await booked();
    const preview = await touringLiveWork(services(app), now(app));
    const before = app.fake.sent.length;
    const result = await standDownTouring(services(app), now(app));
    await app.server.tourCore.settled();
    expect(result).toEqual({ paused: 1, cancelled: 1 });
    const sent = app.fake.sent.slice(before).filter((s) => s.number === PHONE).map((s) => s.content);
    expect(sent).toEqual([preview.texts[0]!.body]);
    expect(await touringLiveWork(services(app), now(app))).toEqual({ live: [], inProgress: false, texts: [] });
  });

  it("keeps the property's setup, so resuming bookings is all a switch back needs", async () => {
    const app = await booked();
    await standDownTouring(services(app), now(app));
    const [property] = app.ws.list();
    expect(property!.state.status).toBe("PUBLISHED_FOR_DEMO");
    expect(property!.state.paused).toBe(true);
    expect(property!.config.units.length).toBeGreaterThan(0);
  });
});
