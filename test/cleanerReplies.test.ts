import { describe, expect, it } from "vitest";
import { draftStatus, earlierThan, replyStateAt, type StoredDraft, type ThreadMessage } from "../src/cleaner-core/replies";

const ana = (id: string): ThreadMessage => ({ id, from: "cleaner", name: "Ana", handled: "none" });

describe("replyStateAt", () => {
  it("answers by the host's group text", () => {
    const list: ThreadMessage[] = [ana("a"), { id: "h", from: "host", name: "Host", channel: "group", handled: "none" }];
    expect(replyStateAt(list, 0)).toEqual({ reply: "answered", by: "group" });
  });

  it("answers by an assistant send to that person", () => {
    const list: ThreadMessage[] = [ana("a"), { id: "s", from: "host", name: "Host", to: "Ana", handled: "sent" }];
    expect(replyStateAt(list, 0)).toEqual({ reply: "answered", by: "assistant" });
  });

  it("answers by an assistant send to the group", () => {
    const list: ThreadMessage[] = [ana("a"), { id: "s", from: "host", name: "Host", to: "the group", handled: "sent" }];
    expect(replyStateAt(list, 0)).toEqual({ reply: "answered", by: "assistant" });
  });

  it("stays open for a send to someone else", () => {
    const list: ThreadMessage[] = [ana("a"), { id: "s", from: "host", name: "Host", to: "Sam", handled: "sent" }];
    expect(replyStateAt(list, 0)).toEqual({ reply: "open" });
  });

  it("stays open when the host's text came before it", () => {
    const list: ThreadMessage[] = [{ id: "h", from: "host", name: "Host", channel: "group", handled: "none" }, ana("a")];
    expect(replyStateAt(list, 1)).toEqual({ reply: "open" });
  });

  it("has no reply state for a host message", () => {
    expect(replyStateAt([{ id: "h", from: "host", name: "Host", channel: "group", handled: "none" }], 0)).toBeUndefined();
  });
});

describe("earlierThan", () => {
  it("gives at most six earlier messages, oldest first", () => {
    const list = Array.from({ length: 9 }, (_, i) => ana(`m${i}`));
    expect(earlierThan(list, 8).map((m) => m.id)).toEqual(["m2", "m3", "m4", "m5", "m6", "m7"]);
  });

  it("gives nothing before the first message", () => {
    expect(earlierThan([ana("a")], 0)).toEqual([]);
  });
});

describe("draftStatus", () => {
  const draft: StoredDraft = { id: "d", replyTo: "a", to: "group", text: "Hall closet", base: "a" };
  it("is ready when nothing came after it", () => {
    expect(draftStatus(draft, [ana("a")])).toBe("ready");
  });
  it("is stale after another inbound message", () => {
    expect(draftStatus(draft, [ana("a"), ana("b")])).toBe("stale");
  });
  it("stays ready after an assistant send to someone else", () => {
    expect(draftStatus(draft, [ana("a"), { id: "s", from: "host", name: "Host", to: "Sam", handled: "sent" }])).toBe("ready");
  });
  it("is answered after the host's group text", () => {
    expect(draftStatus(draft, [ana("a"), { id: "h", from: "host", name: "Host", channel: "group", handled: "none" }])).toBe("answered");
  });
  it("is gone when its message is no longer kept", () => {
    expect(draftStatus(draft, [ana("b")])).toBe("gone");
  });
  it("is changed when the group's members differ from when it was saved", () => {
    const grouped: StoredDraft = { ...draft, members: "+15555550130,+15555550131" };
    expect(draftStatus(grouped, [ana("a")], "+15555550131")).toBe("changed");
    expect(draftStatus(grouped, [ana("a")], "+15555550130,+15555550131")).toBe("ready");
  });
  it("is gone when its base is no longer kept", () => {
    expect(draftStatus({ ...draft, base: "z" }, [ana("a")])).toBe("gone");
  });
});

describe("replyStateAt by who a reply reached", () => {
  const sam = (id: string, channel?: "group"): ThreadMessage => ({ id, from: "contact", name: "Sam", handled: "none", ...(channel ? { channel } : {}) });
  it("a host group text doesn't answer a contact's one-to-one text", () => {
    expect(replyStateAt([sam("a"), { id: "h", from: "host", name: "Host", channel: "group", handled: "none" }], 0)).toEqual({ reply: "open" });
  });
  it("a host group text answers a contact's group text", () => {
    expect(replyStateAt([sam("a", "group"), { id: "h", from: "host", name: "Host", channel: "group", handled: "none" }], 0)).toEqual({ reply: "answered", by: "group" });
  });
  it("a send to the cleaner answers the cleaner whatever her kept name", () => {
    const cleaner: ThreadMessage = { id: "a", from: "cleaner", name: "Cleaner", handled: "none" };
    expect(replyStateAt([cleaner, { id: "s", from: "host", name: "Host", to: "the cleaner", target: "cleaner", handled: "sent" }], 0)).toEqual({ reply: "answered", by: "assistant" });
  });
  it("a send to the cleaner doesn't answer a contact who shares her name", () => {
    const contact: ThreadMessage = { id: "a", from: "contact", name: "Ana", handled: "none" };
    expect(replyStateAt([contact, { id: "s", from: "host", name: "Host", to: "Ana", target: "cleaner", handled: "sent" }], 0)).toEqual({ reply: "open" });
  });
});
