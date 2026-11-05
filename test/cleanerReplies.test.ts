import { describe, expect, it } from "vitest";
import { earlierThan, replyStateAt, type ThreadMessage } from "../src/cleaner-core/replies";

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
