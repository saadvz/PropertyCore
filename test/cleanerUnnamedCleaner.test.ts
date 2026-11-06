import { afterEach, describe, expect, it } from "vitest";
import { cleanupDesks, openDesk, setUp } from "./cleanerDeskHarness";
import { CLEANER, HOST, OBSERVER } from "./wiringProof";

afterEach(() => cleanupDesks());

describe("a group whose cleaner has no saved name", () => {
  it("never calls the cleaner by a made-up name", async () => {
    const opened = openDesk([HOST, CLEANER, OBSERVER], "1");
    // The host saved the cleaner's number without a name.
    await setUp(opened.desk, { cleanerName: "", contacts: [{ name: "Sam", role: "observer", phone: OBSERVER }], groupChat: "cleaner-and-host" });
    await opened.desk.inbound({ id: "yes-host", from: HOST, text: "YES" });
    await opened.desk.inbound({ id: "yes-cleaner", from: CLEANER, text: "YES" });
    await opened.desk.inbound({ id: "yes-schedule", from: CLEANER, text: "YES" });

    const groupBodies = opened.groups.messages.map((message) => message.params.Body ?? "");
    expect(groupBodies.length).toBeGreaterThan(0);
    const everything = JSON.stringify({ sms: opened.sms.sent, group: opened.groups.messages, seats: opened.groups.participantPosts });
    expect(everything).not.toContain("Maria");
  });
});
