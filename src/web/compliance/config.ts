import { resolveDeploymentMode } from "../../install/deployment";
import { toE164 } from "../../messaging/Messenger";

/** Public, unauthenticated compliance pages. Paths are case-sensitive. */
export const COMPLIANCE_PATHS = {
  privacy: "/TourCore/privacy",
  terms: "/TourCore/terms",
  sms: "/TourCore/sms",
} as const;

export type CompliancePageId = keyof typeof COMPLIANCE_PATHS;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Shown when TOURCORE_PUBLIC_BRAND_NAME is unset. */
export const DEFAULT_PUBLIC_BRAND_NAME = "Tour Core";

function oneLine(value: string | undefined): string {
  return value?.replace(/[\r\n]+/g, " ").trim() ?? "";
}

export interface PublicSmsNumber {
  /** E.164 value derived for display. The environment variable is left unchanged. */
  canonical: string;
  /** Human-readable form. U.S. numbers use (NPA) NXX-XXXX; other numbers stay E.164. */
  display: string;
}

export interface PublicComplianceConfig {
  /** Local developer installs may name the missing setting. Other installs must not invent a value. */
  development: boolean;
  /** Public program name. Defaults to Tour Core. */
  brandName: string;
  /** Deployer's legal operator. Absent when TOURCORE_PUBLIC_LEGAL_NAME is empty. */
  legalName?: string;
  legalNameProblem?: "missing";
  smsNumber?: PublicSmsNumber;
  smsNumberProblem?: "missing" | "invalid";
  contactEmail?: string;
  contactEmailProblem?: "missing" | "invalid";
  publicBaseUrl?: string;
  privacyUrl?: string;
  termsUrl?: string;
  smsUrl?: string;
}

/**
 * A public compliance route, including a different capitalization or a trailing
 * slash. `exact` is the capitalized path Twilio and browsers should keep.
 */
export function matchCompliancePath(pathname: string): { id: CompliancePageId; canonical: string; exact: boolean } | undefined {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const hit = (Object.entries(COMPLIANCE_PATHS) as [CompliancePageId, string][]).find(([, path]) => path.toLowerCase() === trimmed.toLowerCase());
  if (!hit) return undefined;
  return { id: hit[0], canonical: hit[1], exact: pathname === hit[1] };
}

export function isPublicCompliancePath(pathname: string): boolean {
  return matchCompliancePath(pathname) !== undefined;
}

/** U.S. numbers are easier to read on a sign or a listing. The canonical E.164 is not rewritten. */
export function formatPublicSmsNumber(canonical: string): string {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(canonical);
  return us ? `(${us[1]}) ${us[2]}-${us[3]}` : canonical;
}

/**
 * Development is a local Tour Core that is not running as production.
 * Hosted, self-hosted, and Grok-managed installs stay in the public wording
 * even when NODE_ENV was left unset.
 */
export function isDevelopmentPublicConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === "production") return false;
  return resolveDeploymentMode(env).mode === "LOCAL_DEVELOPER";
}

export function absoluteComplianceUrl(publicBaseUrl: string | undefined, path: string): string | undefined {
  if (!publicBaseUrl) return undefined;
  return `${publicBaseUrl.replace(/\/+$/, "")}${path}`;
}

/** Privacy and Terms links for SMS. Missing base stays unlabeled rather than using a developer tunnel. */
export function complianceLinkPair(publicBaseUrl: string | undefined): { privacy: string; terms: string } {
  return {
    privacy: absoluteComplianceUrl(publicBaseUrl, COMPLIANCE_PATHS.privacy) ?? "Public URL is not configured",
    terms: absoluteComplianceUrl(publicBaseUrl, COMPLIANCE_PATHS.terms) ?? "Public URL is not configured",
  };
}

/** Public brand. An empty setting stays the product name rather than a blank title. */
export function publicBrandName(env: NodeJS.ProcessEnv = process.env): string {
  return oneLine(env.TOURCORE_PUBLIC_BRAND_NAME) || DEFAULT_PUBLIC_BRAND_NAME;
}

/**
 * Legal operator for this deployment. Empty means the pages must not invent one.
 */
export function publicLegalName(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return oneLine(env.TOURCORE_PUBLIC_LEGAL_NAME) || undefined;
}

/**
 * Public page settings. `publicBaseUrl` is the already-resolved https base
 * (PUBLIC_BASE_URL, or the installation's public address). It is never a
 * hardcoded host.
 */
export function buildComplianceConfig(env: NodeJS.ProcessEnv = process.env, publicBaseUrl?: string): PublicComplianceConfig {
  const rawNumber = env.TOURCORE_PUBLIC_SMS_NUMBER?.trim() || undefined;
  const canonical = rawNumber ? toE164(rawNumber) : undefined;
  const rawEmail = env.TOURCORE_PUBLIC_CONTACT_EMAIL?.trim() || undefined;
  const contactEmail = rawEmail && EMAIL.test(rawEmail) ? rawEmail : undefined;
  const legalName = publicLegalName(env);
  const base = publicBaseUrl?.replace(/\/+$/, "") || undefined;
  const privacyUrl = absoluteComplianceUrl(base, COMPLIANCE_PATHS.privacy);
  const termsUrl = absoluteComplianceUrl(base, COMPLIANCE_PATHS.terms);
  const smsUrl = absoluteComplianceUrl(base, COMPLIANCE_PATHS.sms);
  return {
    development: isDevelopmentPublicConfig(env),
    brandName: publicBrandName(env),
    ...(legalName ? { legalName } : { legalNameProblem: "missing" }),
    ...(canonical ? { smsNumber: { canonical, display: formatPublicSmsNumber(canonical) } } : { smsNumberProblem: rawNumber ? "invalid" : "missing" }),
    ...(contactEmail ? { contactEmail } : { contactEmailProblem: rawEmail ? "invalid" : "missing" }),
    ...(base ? { publicBaseUrl: base } : {}),
    ...(privacyUrl ? { privacyUrl } : {}),
    ...(termsUrl ? { termsUrl } : {}),
    ...(smsUrl ? { smsUrl } : {}),
  };
}
