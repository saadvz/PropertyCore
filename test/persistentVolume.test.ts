import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyHostedStorageGuard,
  coveringMount,
  detectPersistentVolume,
  formatStorageCheck,
  hostedStorageGuard,
  parseMountinfo,
  runStorageCheck,
  storageVolumeHealth,
  type PersistentVolumeIo,
} from "../src/install/persistentVolume";
import { hostedStateDir, validateHostedConfig } from "../src/install/hostedRuntime";

const OVERLAY_ROOT = "23 1 0:22 / / rw,relatime - overlay overlay rw,lowerdir=/l,upperdir=/u,workdir=/w";
const DATA_EXT4 = "50 23 8:16 / /data rw,relatime - ext4 /dev/vdb rw";
const TMP_TMPFS = "45 23 0:45 / /tmp rw,nosuid,nodev - tmpfs tmpfs rw";
const PROC = "24 23 0:23 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw";
const SPACED = "51 23 8:17 / /mnt/my\\040volume rw,relatime - ext4 /dev/vdc rw";
const DATA_NESTED = "52 50 8:16 / /data/sub rw,relatime - ext4 /dev/vdb rw";

const railwayMountinfo = [OVERLAY_ROOT, PROC, DATA_EXT4].join("\n");

function io(mountinfo: string | undefined, devices: Record<string, number> = {}): PersistentVolumeIo {
  return {
    readMountinfo: mountinfo === undefined ? undefined : () => mountinfo,
    stat: (path) => {
      const resolved = resolve(path);
      const hit = Object.entries(devices).find(([key]) => resolve(key) === resolved);
      if (!hit) {
        const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return { dev: hit[1] };
    },
  };
}

describe("mountinfo parsing", () => {
  it("picks the longest covering prefix and treats overlay/root as not mounted", () => {
    const mounts = parseMountinfo(railwayMountinfo);
    expect(mounts).toEqual([
      { mountPoint: "/", fsType: "overlay" },
      { mountPoint: "/proc", fsType: "proc" },
      { mountPoint: "/data", fsType: "ext4" },
    ]);
    expect(coveringMount("/data", mounts)).toEqual({ mountPoint: "/data", fsType: "ext4" });
    expect(coveringMount("/data/app", mounts)).toEqual({ mountPoint: "/data", fsType: "ext4" });
    expect(coveringMount("/tmp/x", mounts)).toEqual({ mountPoint: "/", fsType: "overlay" });
    expect(coveringMount("/data-backup", mounts)?.mountPoint).toBe("/");
  });

  it("unescapes mount points and prefers the longest prefix among nested mounts", () => {
    expect(parseMountinfo(SPACED)).toEqual([{ mountPoint: "/mnt/my volume", fsType: "ext4" }]);
    expect(coveringMount("/mnt/my volume/records", parseMountinfo(SPACED))?.mountPoint).toBe("/mnt/my volume");
    const nested = parseMountinfo([OVERLAY_ROOT, DATA_EXT4, DATA_NESTED].join("\n"));
    expect(coveringMount("/data/sub/home", nested)?.mountPoint).toBe("/data/sub");
  });
});

describe("detectPersistentVolume", () => {
  it("reports a Railway volume at /data as persistent", () => {
    const found = detectPersistentVolume("/data", io(railwayMountinfo, { "/": 1, "/data": 2 }));
    expect(found).toMatchObject({ path: "/data", persistent: true, mount: "/data", fsType: "ext4" });
    expect(detectPersistentVolume("/data/tourcore", io(railwayMountinfo, { "/": 1, "/data": 2 })).mount).toBe("/data");
  });

  it("treats overlay root and tmpfs as not persistent", () => {
    const overlay = detectPersistentVolume("/var/lib/tourcore", io(railwayMountinfo, { "/": 1, "/var": 1, "/var/lib": 1 }));
    expect(overlay.persistent).toBe(false);
    expect(overlay.mount).toBeNull();
    expect(overlay.reason).toMatch(/root filesystem/);

    const tmp = detectPersistentVolume("/tmp/x", io([OVERLAY_ROOT, TMP_TMPFS].join("\n"), { "/": 1, "/tmp": 3 }));
    expect(tmp).toMatchObject({ persistent: false, mount: "/tmp", fsType: "tmpfs" });
    expect(tmp.reason).toMatch(/tmpfs/);
  });

  it("falls back to st_dev when mountinfo is missing", () => {
    const volume = detectPersistentVolume("/data", io(undefined, { "/": 10, "/data": 20 }));
    expect(volume).toMatchObject({ persistent: true, mount: "/data" });
    expect(volume.reason).toMatch(/root filesystem/);

    const same = detectPersistentVolume("/home/app/tourcore-data", io(undefined, { "/": 10, "/home": 10, "/home/app": 10, "/home/app/tourcore-data": 10 }));
    expect(same.persistent).toBe(false);

    const mountPoint = detectPersistentVolume("/mnt/vol", io(undefined, { "/mnt": 10, "/mnt/vol": 30 }));
    expect(mountPoint).toMatchObject({ persistent: true, mount: "/mnt/vol" });
    expect(mountPoint.reason).toMatch(/parent directory/);
  });

  it("walks up to an existing ancestor and does not require the path to exist", () => {
    const found = detectPersistentVolume("/data/missing/home", io(railwayMountinfo, { "/": 1, "/data": 2 }));
    expect(found).toMatchObject({ persistent: true, mount: "/data" });
  });
});

describe("hostedStorageGuard", () => {
  const prod = { TOURCORE_HOME: "/data", RAILWAY_VOLUME_MOUNT_PATH: "/data" };
  const linux = io(railwayMountinfo, { "/": 1, "/data": 2 });

  it("allows the current prod layout (volume at /data, TOURCORE_HOME under /data)", () => {
    expect(hostedStorageGuard(prod, linux)).toMatchObject({ refuse: false, warning: false });
    expect(hostedStorageGuard({ TOURCORE_HOME: "/data/app", RAILWAY_VOLUME_MOUNT_PATH: "/data" }, linux).refuse).toBe(false);
  });

  it("refuses an unset home, a path off the Railway mount, and ephemeral disk", () => {
    expect(hostedStorageGuard({}, linux).refuse).toBe(true);
    expect(hostedStorageGuard({ TOURCORE_HOME: "tourcore-data" }, linux).message).toMatch(/unset/);
    expect(hostedStorageGuard({ TOURCORE_HOME: "/var/lib/tourcore", RAILWAY_VOLUME_MOUNT_PATH: "/data" }, linux).message).toMatch(/not inside/);
    expect(hostedStorageGuard({ TOURCORE_HOME: "/tmp/x" }, io([OVERLAY_ROOT, TMP_TMPFS].join("\n"), { "/": 1, "/tmp": 3 })).refuse).toBe(true);
  });

  it("turns refusal into a warning when TOURCORE_ALLOW_EPHEMERAL_STORAGE=1", () => {
    const ephemeral = { TOURCORE_HOME: "/tmp/x", TOURCORE_ALLOW_EPHEMERAL_STORAGE: "1" };
    const verdict = hostedStorageGuard(ephemeral, io([OVERLAY_ROOT, TMP_TMPFS].join("\n"), { "/": 1, "/tmp": 3 }));
    expect(verdict).toMatchObject({ refuse: false, warning: true });
    expect(verdict.message).toMatch(/ALLOW_EPHEMERAL_STORAGE/);
    expect(hostedStorageGuard({ TOURCORE_ALLOW_EPHEMERAL_STORAGE: "true" }, linux)).toMatchObject({ refuse: false, warning: true });
  });

  it("does not run for local development", () => {
    expect(applyHostedStorageGuard("LOCAL_DEVELOPER", {}, () => undefined).ok).toBe(true);
    expect(applyHostedStorageGuard("GROK_MANAGED_P0", {}, () => undefined).ok).toBe(true);
    const lines: string[] = [];
    expect(applyHostedStorageGuard("HOSTED_RAILWAY_P0", {}, (line) => lines.push(line), linux).ok).toBe(false);
    expect(lines.join("\n")).toMatch(/refusing to start/);
  });
});

describe("check:storage and hosted config", () => {
  it("prints the verdict and exits 1 when hosted mode would refuse, without needing a server", () => {
    const lines: string[] = [];
    const code = runStorageCheck({ TOURCORE_HOME: "/tmp/x" }, (line) => lines.push(line), io([OVERLAY_ROOT, TMP_TMPFS].join("\n"), { "/": 1, "/tmp": 3 }));
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/persistent volume: no/);
    expect(lines.join("\n")).toMatch(/verdict: would refuse/);
    expect(formatStorageCheck(hostedStorageGuard({ TOURCORE_HOME: "/data" }, io(railwayMountinfo, { "/": 1, "/data": 2 }))).join("\n")).toMatch(
      /persistent volume: yes/,
    );

    const warned: string[] = [];
    expect(runStorageCheck({ TOURCORE_HOME: "/tmp/x", TOURCORE_ALLOW_EPHEMERAL_STORAGE: "1" }, (line) => warned.push(line), io([OVERLAY_ROOT, TMP_TMPFS].join("\n"), { "/": 1, "/tmp": 3 }))).toBe(0);
    expect(warned.join("\n")).toMatch(/warning \(ephemeral storage allowed\)/);
  });

  it("lets the escape hatch through validateHostedConfig when the volume is missing", () => {
    expect(hostedStateDir({ TOURCORE_HOME: "/var/tmp", RAILWAY_VOLUME_MOUNT_PATH: "/data" })).toMatchObject({
      problem: expect.stringContaining("Railway volume"),
    });
    expect(hostedStateDir({ TOURCORE_HOME: "/var/tmp", RAILWAY_VOLUME_MOUNT_PATH: "/data", TOURCORE_ALLOW_EPHEMERAL_STORAGE: "1" })).toEqual({
      dir: "/var/tmp",
    });
    expect(
      validateHostedConfig({
        TOURCORE_DEPLOYMENT_MODE: "HOSTED_RAILWAY_P0",
        RAILWAY_PUBLIC_DOMAIN: "demo.up.railway.app",
        PORT: "8080",
        TOURCORE_ALLOW_EPHEMERAL_STORAGE: "1",
      }),
    ).toMatchObject({ ok: true, dataDir: "tourcore-data" });
  });

  it("exposes a read-only health snapshot", () => {
    expect(storageVolumeHealth("/data", io(railwayMountinfo, { "/": 1, "/data": 2 }))).toEqual({
      storagePath: "/data",
      persistentVolume: true,
      volumeMount: "/data",
    });
    expect(storageVolumeHealth("/tmp/x", io([OVERLAY_ROOT, TMP_TMPFS].join("\n"), { "/": 1, "/tmp": 3 })).persistentVolume).toBe(false);
  });
});
