import { HEALTH_PATH } from "../install/checks";
import { AuditExportLinks } from "../operator/auditExportLinks";
import { isPublicCompliancePath } from "../web/compliance/config";

/**
 * The touring process's routes a member of the public may reach through the shared service's
 * /t/<id>/ links: the health check, the visitor identity form, compliance pages, portable backup
 * links, and audit exports (each still checks its own token). The front forwards nothing else, and
 * the process adds only its connector, texting webhooks, and internal routes for the front itself.
 */
export function touringPublicRoute(method: string, path: string): boolean {
  if (method === "GET" && path === HEALTH_PATH) return true;
  if (/^\/portable\/(?:artifacts|uploads)\/art_[A-Za-z0-9_-]{20,80}$/.test(path)) return true;
  if (method === "GET" && isPublicCompliancePath(path)) return true;
  if (method === "GET" && (/^\/verify\/[A-Za-z0-9_-]+$/.test(path) || path === "/verify.js" || path === "/styles.css")) return true;
  if (method === "GET" && AuditExportLinks.parsePath(path)) return true;
  return /^\/api\/verify\/[A-Za-z0-9_-]+$/.test(path) && (method === "GET" || method === "POST");
}
