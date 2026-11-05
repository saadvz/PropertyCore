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
  it("is gone when its base is no longer kept", () => {
    expect(draftStatus({ ...draft, base: "z" }, [ana("a")])).toBe("gone");
  });
});
