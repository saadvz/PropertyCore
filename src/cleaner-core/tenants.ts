export interface ScratchTenant {
  id: "scratch-lane" | "scratch-court";
  property: { id: string; address: string; timeZone: string };
  ownerPhone: string;
  cleanerPhone: string;
  unapprovedPhone: string;
  pin: string;
  hostName: string;
}

/** Two Scratch tenants. Phones are 555 test numbers. Pins stay out of texts except the private door-code send. */
export const SCRATCH_TENANTS: readonly ScratchTenant[] = [
  {
    id: "scratch-lane",
    property: { id: "prop_12_scratch_lane", address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" },
    ownerPhone: "+15555550100",
    cleanerPhone: "+15555550101",
    unapprovedPhone: "+15555550199",
    pin: "4821",
    hostName: "Scratch",
  },
  {
    id: "scratch-court",
    property: { id: "prop_8_scratch_court", address: "8 Scratch Court, Teaneck, NJ 07666", timeZone: "America/New_York" },
    ownerPhone: "+15555550110",
    cleanerPhone: "+15555550111",
    unapprovedPhone: "+15555550119",
    pin: "7392",
    hostName: "Scratch",
  },
];

export function scratchTenant(id: string | undefined): ScratchTenant | undefined {
  return SCRATCH_TENANTS.find((tenant) => tenant.id === id);
}

/** True when `phone` is this Scratch tenant's owner, cleaner, or unapproved phone. */
export function isTenantPhone(tenant: ScratchTenant, phone: string): boolean {
  return phone === tenant.ownerPhone || phone === tenant.cleanerPhone || phone === tenant.unapprovedPhone;
}

/** True when `phone` belongs to a different Scratch tenant than `tenantId`. Unknown tenant ids match nothing. */
export function isOtherScratchTenantPhone(tenantId: string, phone: string): boolean {
  const mine = scratchTenant(tenantId);
  if (!mine) return false;
  return SCRATCH_TENANTS.some((tenant) => {
    if (tenant.id === mine.id) return false;
    return isTenantPhone(tenant, phone);
  });
}
