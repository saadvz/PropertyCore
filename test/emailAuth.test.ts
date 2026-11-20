import { describe, expect, it } from "vitest";
import { authVerdict } from "../src/hub/emailAuth";

/** The sender check from an email's Authentication-Results header (#263). Made-up headers, documentation IPs. */

const GMAIL_PASS =
  "Authentication-Results: mx.google.com;\n       dkim=pass header.i=@booking.com header.s=bk1 header.b=AbCd1234;\n       spf=pass (google.com: domain of bounce@mail.booking.com designates 192.0.2.10 as permitted sender) smtp.mailfrom=bounce@mail.booking.com;\n       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=booking.com";

const SPOOF =
  "Authentication-Results: mx.google.com;\n       dkim=pass header.i=@evil.example header.s=s1 header.b=XyZ;\n       spf=pass (google.com: domain of a@evil.example designates 198.51.100.7 as permitted sender) smtp.mailfrom=a@evil.example;\n       dmarc=fail (p=REJECT sp=REJECT dis=QUARANTINE) header.from=booking.com";

describe("authVerdict", () => {
  it("passes Gmail's header with an aligned DMARC pass", () => {
    expect(authVerdict(GMAIL_PASS, "booking.com")).toBe("pass");
  });

  it("fails a spoof whose only passes are for the sender's own domain", () => {
    expect(authVerdict(SPOOF, "booking.com")).toBe("fail");
    const noDmarc = "Authentication-Results: mx.google.com; dkim=pass header.d=evil.example; spf=pass smtp.mailfrom=a@evil.example";
    expect(authVerdict(noDmarc, "booking.com")).toBe("fail");
  });

  it("passes DKIM signed by the From domain or its parent, and SPF on an aligned bounce domain", () => {
    expect(authVerdict("Authentication-Results: mx.google.com; dkim=pass header.d=homeaway.com", "messages.homeaway.com")).toBe("pass");
    expect(authVerdict("Authentication-Results: mx.google.com; dkim=none; spf=pass smtp.mailfrom=bounce@mail.booking.com", "booking.com")).toBe("pass");
    expect(authVerdict("Authentication-Results: mx.google.com; dkim=pass header.d=notbooking.com", "booking.com")).toBe("fail");
    expect(authVerdict("Authentication-Results: mx.google.com; dkim=pass header.d=com", "booking.com")).toBe("fail");
  });

  it("only reads the topmost header: a forged one further down counts for nothing", () => {
    const forged = `Authentication-Results: mx.google.com; dkim=fail header.d=booking.com; spf=softfail smtp.mailfrom=x@booking.com; dmarc=fail header.from=booking.com\nAuthentication-Results: mx.google.com; dmarc=pass header.from=booking.com`;
    expect(authVerdict(forged, "booking.com")).toBe("fail");
  });

  it("is unknown when the topmost header isn't from a mailbox provider it knows, even with a pass below it", () => {
    const relay = `Authentication-Results: relay.evil.example; dmarc=pass header.from=booking.com\n${GMAIL_PASS}`;
    expect(authVerdict(relay, "booking.com")).toBe("unknown");
  });

  it("is unknown with no header, an empty one, or a header with no authserv-id", () => {
    expect(authVerdict(undefined, "booking.com")).toBe("unknown");
    expect(authVerdict("  ", "booking.com")).toBe("unknown");
    expect(authVerdict("Authentication-Results: spf=pass smtp.mailfrom=x@booking.com", "booking.com")).toBe("unknown");
  });

  it("takes the header value alone, without its name", () => {
    expect(authVerdict("mx.google.com; dmarc=pass header.from=booking.com", "booking.com")).toBe("pass");
  });

  it("knows Outlook's and Yahoo's servers", () => {
    expect(authVerdict("Authentication-Results: BN8PR12.prod.protection.outlook.com; dmarc=pass header.from=booking.com", "booking.com")).toBe("pass");
    expect(authVerdict("Authentication-Results: atlas-production.v2.mail.yahoo.com; dmarc=fail header.from=booking.com", "booking.com")).toBe("fail");
  });
});
