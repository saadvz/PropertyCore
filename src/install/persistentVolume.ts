import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { isHostedRailway, type DeploymentMode } from "./deployment";

/**
 * HOSTED_RAILWAY_P0 must keep TOURCORE_HOME on a mounted volume. The
 * container disk (overlay / root) is wiped on every Railway deploy.
 *
 * Detection prefers /proc/self/mountinfo (longest covering prefix; overlay
 * and the root filesystem are not persistent). When mountinfo is missing it
 * compares st_dev of the path against its parent and against /.
 */

const EPHEMERAL_FS = new Set(["overlay", "overlayfs", "tmpfs", "rootfs", "aufs", "squashfs"]);

export interface MountEntry {
  mountPoint: string;
  fsType: string;
}

export interface PathStat {
  dev: number;
}

/** Tests inject mountinfo text and stats so detection does not read the host. */
export interface PersistentVolumeIo {
  readMountinfo?: () => string | undefined;
  stat?: (path: string) => PathStat;
  realpath?: (path: string) => string;
}

export interface VolumeDetection {
  path: string;
  persistent: boolean;
  mount: string | null;
  fsType: string | null;
  reason: string;
}

export interface StorageVolumeHealth {
  storagePath: string;
  persistentVolume: boolean;
  volumeMount: string | null;
}

export interface StorageGuardVerdict {
  refuse: boolean;
  warning: boolean;
  message: string;
  detection: VolumeDetection;
}

export function allowEphemeralStorage(env: NodeJS.ProcessEnv): boolean {
  const raw = env.TOURCORE_ALLOW_EPHEMERAL_STORAGE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function pathIsInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Kernel mountinfo escapes spaces and similar as octal (`\\040`). */
export function unescapeMountField(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

export function parseMountinfo(text: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const sep = line.indexOf(" - ");
    if (sep === -1) continue;
    const left = line.slice(0, sep).split(" ");
    const right = line.slice(sep + 3).split(" ");
    const mountPoint = left[4];
    const fsType = right[0];
    if (!mountPoint || !fsType) continue;
    entries.push({ mountPoint: unescapeMountField(mountPoint), fsType });
  }
  return entries;
}

export function coveringMount(target: string, mounts: MountEntry[]): MountEntry | undefined {
  const path = resolve(target);
  let best: MountEntry | undefined;
  for (const mount of mounts) {
    if (!mountCovers(path, mount.mountPoint)) continue;
    if (!best || mount.mountPoint.length > best.mountPoint.length) best = mount;
  }
  return best;
}

export function isPersistentMount(mount: MountEntry | undefined): boolean {
  if (!mount) return false;
  if (mount.mountPoint === "/") return false;
  return !EPHEMERAL_FS.has(mount.fsType.toLowerCase());
}

export function defaultPersistentVolumeIo(): PersistentVolumeIo {
  return {
    readMountinfo: () => {
      try {
        return readFileSync("/proc/self/mountinfo", "utf8");
      } catch {
        return undefined;
      }
    },
    stat: (path) => statSync(path),
    realpath: (path) => realpathSync(path),
  };
}

export function detectPersistentVolume(target: string, io: PersistentVolumeIo = defaultPersistentVolumeIo()): VolumeDetection {
  if (!target.trim()) {
    return { path: "", persistent: false, mount: null, fsType: null, reason: "TOURCORE_HOME is unset." };
  }
  const path = resolveHome(target, io);
  const mountText = io.readMountinfo?.();
  const mounts = mountText !== undefined && mountText !== "" ? parseMountinfo(mountText) : undefined;
  const byDev = io.stat ? detectByDevice(path, io.stat) : undefined;

  if (mounts) {
    const covering = coveringMount(path, mounts);
    if (isPersistentMount(covering) && covering) {
      return {
        path,
        persistent: true,
        mount: covering.mountPoint,
        fsType: covering.fsType,
        reason: `Covered by ${covering.fsType} mount at ${covering.mountPoint}.`,
      };
    }
    if (covering) {
      return {
        path,
        persistent: false,
        mount: covering.mountPoint === "/" ? null : covering.mountPoint,
        fsType: covering.fsType,
        reason:
          covering.mountPoint === "/"
            ? "Path is on the root filesystem, which is not a persistent volume."
            : `Mount at ${covering.mountPoint} is ${covering.fsType}, which is not persistent.`,
      };
    }
  }

  if (byDev) {
    return { path, persistent: byDev.persistent, mount: byDev.mount, fsType: null, reason: byDev.reason };
  }

  return { path, persistent: false, mount: null, fsType: null, reason: "Could not inspect mounts or devices for this path." };
}

export function storageVolumeHealth(path: string, io?: PersistentVolumeIo): StorageVolumeHealth {
  const detection = detectPersistentVolume(path, io);
  return {
    storagePath: detection.path || path,
    persistentVolume: detection.persistent,
    volumeMount: detection.mount,
  };
}

/**
 * Whether HOSTED_RAILWAY_P0 would refuse to start for this environment.
 * Local development never calls this. The check command always does, so a
 * path can be verified without starting the server.
 */
export function hostedStorageGuard(env: NodeJS.ProcessEnv, io: PersistentVolumeIo = defaultPersistentVolumeIo()): StorageGuardVerdict {
  const allow = allowEphemeralStorage(env);
  const home = env.TOURCORE_HOME?.trim();
  const railwayMount = env.RAILWAY_VOLUME_MOUNT_PATH?.trim();
  const detection = detectPersistentVolume(home || railwayMount || "", io);

  if (!home || home === "tourcore-data") {
    return conclude(
      "HOSTED_RAILWAY_P0 refusing to start: TOURCORE_HOME is unset. Set it to the Railway volume (usually /data). The container disk is wiped on deploy.",
      detection,
      allow,
    );
  }

  if (railwayMount && !pathIsInside(home, railwayMount)) {
    return conclude(
      "HOSTED_RAILWAY_P0 refusing to start: TOURCORE_HOME is not inside the Railway volume mount. The container disk is not durable.",
      { ...detection, path: resolve(home), persistent: false },
      allow,
    );
  }

  if (!detection.persistent) {
    return conclude(
      `HOSTED_RAILWAY_P0 refusing to start: TOURCORE_HOME is not on a persistent volume. ${detection.reason} Mount a Railway volume at /data and set TOURCORE_HOME there.`,
      detection,
      allow,
    );
  }

  return {
    refuse: false,
    warning: false,
    message: `TOURCORE_HOME is on a persistent volume (${detection.mount ?? detection.path}).`,
    detection,
  };
}

/** No-op outside HOSTED_RAILWAY_P0 so local setup and tests are unchanged. */
export function applyHostedStorageGuard(
  mode: DeploymentMode,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  io?: PersistentVolumeIo,
): { ok: boolean; verdict?: StorageGuardVerdict } {
  if (!isHostedRailway(mode)) return { ok: true };
  const verdict = hostedStorageGuard(env, io);
  if (verdict.warning) {
    log(`WARNING: ${verdict.message}`);
    log("WARNING: Records on this disk will be wiped on the next deploy. Unset TOURCORE_ALLOW_EPHEMERAL_STORAGE for a real host.");
  }
  if (verdict.refuse) {
    log(verdict.message);
    return { ok: false, verdict };
  }
  return { ok: true, verdict };
}

export function formatStorageCheck(verdict: StorageGuardVerdict): string[] {
  const { detection } = verdict;
  const status = verdict.refuse ? "would refuse" : verdict.warning ? "warning (ephemeral storage allowed)" : "ok";
  return [
    `storage path: ${detection.path || "(unset)"}`,
    `persistent volume: ${detection.persistent ? "yes" : "no"}`,
    `volume mount: ${detection.mount ?? "(none)"}`,
    `verdict: ${status}`,
    verdict.warning ? `WARNING: ${verdict.message}` : verdict.message,
  ];
}

/**
 * Print the hosted-storage verdict for TOURCORE_HOME without starting the
 * server or writing files. Exit 1 when hosted mode would refuse.
 */
export function runStorageCheck(
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = console.log,
  io?: PersistentVolumeIo,
): number {
  const verdict = hostedStorageGuard(env, io);
  for (const line of formatStorageCheck(verdict)) log(line);
  return verdict.refuse ? 1 : 0;
}

function conclude(message: string, detection: VolumeDetection, allow: boolean): StorageGuardVerdict {
  if (allow) {
    return {
      refuse: false,
      warning: true,
      message: `${message} TOURCORE_ALLOW_EPHEMERAL_STORAGE is set; starting anyway for a disposable demo.`,
      detection,
    };
  }
  return { refuse: true, warning: false, message, detection };
}

function mountCovers(target: string, mountPoint: string): boolean {
  if (mountPoint === "/") return true;
  const prefix = resolve(mountPoint);
  return target === prefix || target.startsWith(`${prefix}/`);
}

function resolveHome(target: string, io: PersistentVolumeIo): string {
  const resolved = resolve(target);
  if (!io.realpath) return resolved;
  try {
    return io.realpath(resolved);
  } catch {
    return resolved;
  }
}

function nearestExisting(path: string, stat: (p: string) => PathStat): { path: string; dev: number } | undefined {
  let current = resolve(path);
  for (;;) {
    try {
      return { path: current, dev: stat(current).dev };
    } catch {
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

function detectByDevice(path: string, stat: (p: string) => PathStat): { persistent: boolean; mount: string | null; reason: string } {
  let rootDev: number | undefined;
  try {
    rootDev = stat("/").dev;
  } catch {
    rootDev = undefined;
  }
  const found = nearestExisting(path, stat);
  if (!found) {
    return { persistent: false, mount: null, reason: "Path does not exist and no ancestor could be inspected." };
  }
  let parentDev: number | undefined;
  const parent = dirname(found.path);
  if (parent !== found.path) {
    try {
      parentDev = stat(parent).dev;
    } catch {
      parentDev = undefined;
    }
  }
  if (rootDev !== undefined && found.dev !== rootDev) {
    return { persistent: true, mount: found.path, reason: "Device id differs from the root filesystem." };
  }
  if (parentDev !== undefined && found.dev !== parentDev && found.path !== "/") {
    return { persistent: true, mount: found.path, reason: "Device id differs from the parent directory (mount point)." };
  }
  return { persistent: false, mount: null, reason: "Path is on the same device as the root filesystem." };
}
