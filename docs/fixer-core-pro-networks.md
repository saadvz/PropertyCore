# Fixer Core: pro networks it could connect to

Research for #175 (Phase 1, #159). Checked 2026-11-07, from each service's public docs and announcements. Links are at the end.

## The question

Which services give direct, programmatic access to home-service pros, so Fixer Core can add their candidates to the shortlist (#172) next to the agent's own search? And can any of them take the next steps in #173 (request a quote, book) on the host's behalf?

## Recommendation

**Connect Thumbtack first, and only for search.**

1. **Now (v1): no server-side connection.** As planned in the spec, the agent does the outside work. Where the host's agent already has Thumbtack (the Thumbtack app in ChatGPT, and in Claude since April 2026), the agent can use it like any other search and record the candidates with `source: "thumbtack"`. We found no Thumbtack app for Grok or Muse, so on those the agent uses its own web search.
2. **Apply for Thumbtack partner access now** (developers.thumbtack.com, "Request Access"). Lead time and fees aren't published. Partner access gets the Search Pros toolset on Thumbtack's MCP server. That returns what the agent's web search can't reliably get: a verified-license flag with license numbers, a background-check flag, rating, review count, a price hint and response time. That's the case for a direct connection later.
3. **Don't book through a network.** Thumbtack's only booking path (Preset Jobs) charges the host through Stripe, works only 72 hours to 31 days ahead, only in categories Thumbtack sets up for the partner, and replaces the search tools. That clashes with "there is no payment step" (#159) and with urgent repairs between stays. The agent keeps contacting and booking pros directly (#173).
4. **Skip Butler's Book, Amenify and Angi for now.** Butler's Book isn't a service. Amenify serves multifamily resident apps. Angi has no public API for finding pros.
5. **Maybe later: Taskrabbit** for handyman and small upkeep jobs, if a partnership is possible. It has a real booking API, but it's built for retailers' checkouts and it takes payment.

## Comparison

| | API to find pros | How to get access | Trades and area | Search / quote / book | Payment | What it returns per pro |
| --- | --- | --- | --- | --- | --- | --- |
| **Thumbtack** | Yes: REST Partner API and an MCP server | Partner onboarding. OAuth client ID and secret, separate for staging and production | Hundreds of categories, including plumbing, electrical, HVAC, cleaning and handyman. US only. Coverage thins out in rural ZIP codes | Search: yes. Quote request: yes (Requests API). Booking: only Preset Jobs, a separate toolset that is still in development | Partner fees aren't published. Pros pay Thumbtack for leads. Preset Jobs: the host pays upfront through Stripe, unless the partner pays | Rating, review count, reviews, price hint, license verified and license list, background check, hires, response time, profile link. No availability. No phone or email |
| **Angi** | No public API. The Lead Integration API only sends leads to pros | Partnerships only (apps in ChatGPT since Mar 2026, in Gemini, and Alexa+ announced for 2026) | Broad home services, US | In ChatGPT: recommendations, then the host finishes on angi.com. No booking | n/a | n/a through an API |
| **Amenify** | Partner APIs for resident apps and property management systems | Partnership. No self-serve sign-up | Cleaning, chores, handyman, move-out cleaning, pet care, deliveries. Says 500+ US cities. No plumbing, HVAC or electrical listed. No short-term rental hosts mentioned | Booking happens through the partner's app, for residents | Residents pay through Amenify | Not documented publicly |
| **Butler's Book** | None. It's a household manual (contractors, utilities, maintenance dates), not a service | n/a | n/a | n/a | n/a | n/a |
| **Taskrabbit** (added) | Yes: Home Services Partner API | API key from a Taskrabbit partnership manager. Sandbox and production | Services set up per partner brand. Taskers generally do handyman, mounting, assembly and cleaning work, not licensed trades | Estimate, availability, bid (holds a slot), book, status, cancel, webhooks | Booking confirms payment. The customer must accept Taskrabbit's terms | Not documented publicly |
| **Yelp AI API** (added) | Search and Q&A over Yelp listings, including an MCP server | Paid data license, with a free trial | Broad, US and more | Search only. Reservations are for restaurants. No quote requests | API fees | Rating, reviews, photos, hours, business details |

Also seen and not pursued: **Agent Service Exchange**, offered in a comment on #175. It's a small MCP pilot covering plumbing, heating and cleaning in Vienna, Austria. It sends enquiries only, with no availability, prices or verified licensing. Fixer Core v1 is US only. We didn't run its client or endpoint. **Turno** is moving into maintenance and handyman services for short-term rental operators (January 2026), but we found no API.

## Thumbtack in detail

### Access

- Partners request access at developers.thumbtack.com. Thumbtack sets up the OAuth client during onboarding and picks one toolset for it. The API terms follow Thumbtack's consumer terms, and Thumbtack can remove access at any time.
- MCP server: `https://mcp.thumbtack.com/mcp` (staging: `https://staging-mcp.thumbtack.com/mcp`). It uses Streamable HTTP, is stateless, and needs a client-credentials token on every call, including `tools/list`.
- **One toolset per partner**: Search Pros (the default) or Preset Job. Turning on Preset Job removes the search tools from that client.
- Fees aren't published. Ask partnerships@thumbtack.com.

### Search Pros toolset

- `search_home_service_pros` takes the job in plain words and a ZIP code. `filter_home_service_pros` narrows results with Thumbtack's own clarifying questions. `get_reviews_for_pros` returns up to 20 reviews per pro. `get_category_recommendations` suggests categories.
- **At most 6 pros per search.** A search ID lasts 7 days.
- Per pro: `businessID`, name, introduction, `rating`, `numberOfReviews`, `priceInfo` (text such as "$125/service call (waived if hired)"), `numberOfHires`, `isTopPro`, `isBackgroundChecked`, `isBusinessLicenseVerified`, `licenses` (number, state, type, authority URL), labels such as "Licensed pro", `responseTimeHours`, and `servicePageURL`.
- **No availability, phone or email.** The host reaches the pro through Thumbtack: on the pro's page, or through the Requests API.

### Requesting a quote

- `POST /api/v4/requests` sends a project request to one or more chosen `businessIDs`. It creates a lead those pros answer on Thumbtack.
- Replies are Thumbtack messages. A partner can subscribe to a customer's messages with a `MessageCreatedV4` webhook, but those user endpoints take the customer's own authorization. So **each host would need a Thumbtack account linked to Fixer Core** before Fixer Core could follow replies itself.

### Booking (Preset Jobs, in development)

- Fixed-price jobs in categories Thumbtack sets up for the partner. The docs' examples are furniture assembly and TV mounting.
- The appointment must be **at least 72 hours ahead** and at most 31 days.
- Before booking, the agent must show Thumbtack's Terms of Use and Privacy Policy and get the customer's explicit yes. It then mints a **Stripe shared payment token** for the exact total, unless the partner's configuration pays.
- Booking creates or links a Thumbtack account for the customer's email, and shares their phone number with the pro who claims the job. There is no step where the host picks the pro.

## What this means for Fixer Core

| Fixer Core need (#172, #173) | What a network gives |
| --- | --- |
| Shortlist fields: name, rating, review count, licensed, cost range, earliest availability, source | Thumbtack covers name, rating, review count and licensed (from `isBusinessLicenseVerified`). Cost is text, so keep the raw `priceInfo` and treat `costRange` as optional. Earliest availability is usually unknown for network candidates. |
| How to reach the pro | Thumbtack candidates have no phone or email, only a `networkRef` (`businessID`) and a profile link. Contact goes through Thumbtack. |
| How the pro replies | Through Thumbtack messages. A reply channel of "network" sits alongside call, email and text. |
| Booked time inside the job window | Only Preset Jobs book, and those are 72+ hours out. Most repairs are booked by the agent directly, as #173 plans. |
| No payment step | Thumbtack Preset Jobs and Taskrabbit both take payment, so neither is used for booking. |
| Host approves contact (#172) | A Requests API call contacts pros, so it counts as contact and needs the host's pick first, the same as a call or email. |
| What Fixer Core would need from us later | A Thumbtack partner client ID and secret (one per deployment, kept as secrets), and for quote requests, a linked Thumbtack account per host plus a webhook for replies. |

## Open questions for Saad

- Apply for Thumbtack partner access now? It costs nothing to ask, and the answer sets when a direct search connection could land.
- Which agents does Fixer Core run on in v1? The Thumbtack app exists in ChatGPT and Claude, not in Grok, so on Grok the agent relies on its own search.

## Sources

- Thumbtack Partner Platform: overview, Find Pros, Requests, Users, On-Demand Orders, MCP Server (Toolsets, Connect and Authenticate, Search Pros Tools, Preset Job Tools, Limitations and FAQ), API Terms of Use. https://developers.thumbtack.com/docs
- Thumbtack and OpenAI (ChatGPT app), Business Wire, 2025-10-06. https://www.businesswire.com/news/home/20251006760229/en
- Thumbtack in Claude, Business Wire, 2026-04-23. https://www.businesswire.com/news/home/20260423884720/en/Thumbtack-Delivers-Home-Services-Experience-in-Anthropics-Claude
- Angi Lead Integration API. https://intercom.help/angi/en/articles/15304819-angi-lead-integration-api
- Angi app in ChatGPT, 2026-03-04. https://www.nasdaq.com/press-release/angi-launches-angi-app-chatgpt-2026-03-04
- Angi in Gemini. https://www.angi.com/articles/gemini-marketplace-announcement.htm
- Alexa+ with Angi and Yelp, 2025-12-23. https://www.aboutamazon.com/news/devices/alexa-plus-voice-booking-integrations
- Amenify technology and API. https://amenify.com/amenify-technology and https://amenify.com/blog/amenify-api-for-resident-apps
- Butler's Book. https://www.artofmanliness.com/skills/homeownership/butler-s-book/
- Taskrabbit Home Services API. https://developer.taskrabbit.com/docs/overview-taskrabbit-home-services-api
- Yelp AI API and MCP server. https://business.yelp.com/data/products/fusion-ai/ and https://glama.ai/mcp/servers/Yelp/yelp-mcp
- Turno maintenance for short-term rental operators, 2026-01-02. https://www.buzzsprout.com/2327631/episodes/18425037-find-your-handyman-with-turno
- Agent Service Exchange (comment on #175). https://github.com/PatrickPi1312/agent-service-exchange
