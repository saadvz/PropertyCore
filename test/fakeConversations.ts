/**
 * A fake Twilio Conversations API for Cleaner Core's group texts. It follows the group texting
 * model (https://www.twilio.com/docs/conversations/group-texting): SMS participants have only
 * MessagingBinding.Address, one chat participant has an Identity and a
 * MessagingBinding.ProjectedAddress, and messages carry an Author. It records every call and
 * never leaves the machine.
 */

const ROOT = "https://conversations.twilio.com/v1/Conversations";
/** Group texting allows at most 10 participants, the chat participant included. */
const MAX_PARTICIPANTS = 10;

export interface FakeParticipant {
  sid: string;
  identity?: string;
  address?: string;
  proxyAddress?: string;
  projectedAddress?: string;
}

export interface ConversationPost {
  conversationSid: string;
  /** The SMS participants' phones, sorted. */
  to: string[];
  body: string;
}

export interface FakeConversations {
  impl: typeof fetch;
  posts: ConversationPost[];
  messages: { conversationSid: string; params: Record<string, string> }[];
  participantPosts: { conversationSid: string; params: Record<string, string> }[];
  webhooks: { conversationSid: string; params: Record<string, string> }[];
  deleted: { conversationSid: string; participantSid: string }[];
  created: string[];
  /** Conversations deleted whole. */
  removed: string[];
  people(conversationSid: string): FakeParticipant[] | undefined;
  calls(): number;
  blockMembership(): void;
  /** Twilio closes the conversation, so it takes no more posts. */
  close(conversationSid: string): void;
  /** An old conversation made the proxy way: each phone bound to the Twilio number, no chat participant. */
  seedProxy(phones: string[], proxy: string): string;
  /** A group text that already exists on a line, with its reply webhook: another account's leftover, or a sibling property's. */
  seedGroup(phones: string[], line: string, hookUrl: string, identity?: string): string;
}

function fields(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(String(init?.body ?? ""))) out[key] = value;
  return out;
}

export function fakeConversations(
  options: { failMessages?: boolean; failWebhooks?: boolean; failConversationDeletes?: boolean; refusePhone?: string } = {},
): FakeConversations {
  const conversations = new Map<string, FakeParticipant[]>();
  const removed: string[] = [];
  const posts: ConversationPost[] = [];
  const messages: FakeConversations["messages"] = [];
  const participantPosts: FakeConversations["participantPosts"] = [];
  const webhooks: FakeConversations["webhooks"] = [];
  const deleted: FakeConversations["deleted"] = [];
  const created: string[] = [];
  let calls = 0;
  let sequence = 0;
  let blocked = false;
  const closed = new Set<string>();
  const hooks = new Map<string, string[]>();
  const LIST = "https://conversations.twilio.com/v1/ParticipantConversations";
  /** The line a group texts from, and its phones, sorted. Undefined for a conversation that is no group text. */
  const groupOf = (people: FakeParticipant[]) => {
    const line = people.find((person) => person.projectedAddress)?.projectedAddress;
    return line ? { line, phones: people.flatMap((person) => (person.address ? [person.address] : [])).sort().join(",") } : undefined;
  };
  const hex = (n: number) => n.toString(16).padStart(32, "0");
  const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

  const impl: typeof fetch = async (input, init) => {
    calls += 1;
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === ROOT && method === "POST") {
      const sid = `CH${hex(++sequence)}`;
      conversations.set(sid, []);
      created.push(sid);
      return reply(201, { sid });
    }
    if (url.startsWith(`${LIST}?`) && method === "GET") {
      const identity = new URL(url).searchParams.get("Identity");
      const found = [...conversations.entries()].flatMap(([sid, people]) =>
        people.filter((person) => person.identity && person.identity === identity).map((person) => ({ conversation_sid: sid, participant_messaging_binding: { projected_address: person.projectedAddress ?? null } })),
      );
      return reply(200, { conversations: found, meta: { next_page_url: null } });
    }
    if (!url.startsWith(`${ROOT}/`)) return reply(404, {});
    const [rawSid, ...rest] = url.slice(ROOT.length + 1).split("/");
    const conversationSid = decodeURIComponent(rawSid ?? "");
    const people = conversations.get(conversationSid);
    if (!people) return reply(404, {});
    const tail = rest.join("/").split("?")[0] ?? "";
    if (tail === "" && method === "GET") return reply(200, { sid: conversationSid, state: closed.has(conversationSid) ? "closed" : "active" });
    if (tail === "" && method === "DELETE") {
      if (options.failConversationDeletes) return reply(500, {});
      conversations.delete(conversationSid);
      removed.push(conversationSid);
      return reply(204, {});
    }
    if (tail === "Messages" && method === "POST") {
      if (options.failMessages || closed.has(conversationSid)) return reply(500, {});
      const params = fields(init);
      messages.push({ conversationSid, params });
      const to = people.flatMap((person) => (person.address ? [person.address] : [])).sort();
      posts.push({ conversationSid, to, body: params.Body ?? "" });
      return reply(201, { sid: `IM${hex(messages.length)}` });
    }
    if (tail === "Webhooks" && method === "GET") {
      return reply(200, { webhooks: (hooks.get(conversationSid) ?? []).map((hookUrl) => ({ target: "webhook", configuration: { url: hookUrl, method: "POST" } })), meta: { next_page_url: null } });
    }
    if (tail === "Webhooks" && method === "POST") {
      if (options.failWebhooks) return reply(500, {});
      const hook = fields(init)["Configuration.Url"];
      if (hook) hooks.set(conversationSid, [...(hooks.get(conversationSid) ?? []), hook]);
      webhooks.push({ conversationSid, params: fields(init) });
      return reply(201, { sid: `WH${hex(webhooks.length)}` });
    }
    if (tail === "Participants" || tail.startsWith("Participants/")) {
      if (blocked) return reply(500, {});
      if (tail === "Participants" && method === "GET") {
        return reply(200, {
          participants: people.map((person) => ({
            sid: person.sid,
            identity: person.identity ?? null,
            messaging_binding: person.address
              ? { type: "sms", address: person.address, ...(person.proxyAddress ? { proxy_address: person.proxyAddress } : {}) }
              : person.projectedAddress
                ? { projected_address: person.projectedAddress }
                : null,
          })),
          meta: { next_page_url: null },
        });
      }
      if (tail === "Participants" && method === "POST") {
        const params = fields(init);
        participantPosts.push({ conversationSid, params });
        if (people.length >= MAX_PARTICIPANTS) return reply(400, {});
        const identity = params.Identity;
        const address = params["MessagingBinding.Address"];
        const proxyAddress = params["MessagingBinding.ProxyAddress"];
        const projectedAddress = params["MessagingBinding.ProjectedAddress"];
        const grouped = people.some((person) => person.projectedAddress) || Boolean(projectedAddress);
        // A group texting conversation takes no proxy addresses.
        if (grouped && (proxyAddress || people.some((person) => person.proxyAddress))) return reply(400, {});
        // Twilio's answer for a phone it won't put in a group text.
        if (address && address === options.refusePhone) return reply(400, { code: 50407, message: "Invalid messaging binding address", status: 400 });
        if (address && people.some((person) => person.address === address)) return reply(409, {});
        if (identity && people.some((person) => person.identity === identity)) return reply(409, {});
        if (!address && !identity) return reply(400, {});
        // Twilio allows one group text per line and set of phones.
        if (address) {
          const next = groupOf([...people, { sid: "", address }]);
          for (const [otherSid, others] of conversations) {
            const other = otherSid === conversationSid ? undefined : groupOf(others);
            if (next && other && other.line === next.line && other.phones === next.phones) {
              return reply(409, { code: 50438, message: `Group MMS with given participant list already exists as Conversation ${otherSid}`, status: 409 });
            }
          }
        }
        const person: FakeParticipant = {
          sid: `MB${hex(++sequence)}`,
          ...(identity ? { identity } : {}),
          ...(address ? { address } : {}),
          ...(proxyAddress ? { proxyAddress } : {}),
          ...(projectedAddress ? { projectedAddress } : {}),
        };
        people.push(person);
        return reply(201, { sid: person.sid });
      }
      if (method === "DELETE" && tail.startsWith("Participants/")) {
        const participantSid = decodeURIComponent(tail.slice("Participants/".length));
        const index = people.findIndex((person) => person.sid === participantSid);
        if (index < 0) return reply(404, {});
        people.splice(index, 1);
        deleted.push({ conversationSid, participantSid });
        return reply(204, {});
      }
    }
    return reply(404, {});
  };

  return {
    impl,
    posts,
    messages,
    participantPosts,
    webhooks,
    deleted,
    created,
    removed,
    people: (sid) => conversations.get(sid),
    calls: () => calls,
    blockMembership() {
      blocked = true;
    },
    close(conversationSid) {
      closed.add(conversationSid);
    },
    seedProxy(phones, proxy) {
      const sid = `CH${hex(++sequence)}`;
      conversations.set(
        sid,
        phones.map((address) => ({ sid: `MB${hex(++sequence)}`, address, proxyAddress: proxy })),
      );
      return sid;
    },
    seedGroup(phones, line, hookUrl, identity = "cleaner-core") {
      const sid = `CH${hex(++sequence)}`;
      conversations.set(sid, [{ sid: `MB${hex(++sequence)}`, identity, projectedAddress: line }, ...phones.map((address) => ({ sid: `MB${hex(++sequence)}`, address }))]);
      hooks.set(sid, [hookUrl]);
      return sid;
    },
  };
}
