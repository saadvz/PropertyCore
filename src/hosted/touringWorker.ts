import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { RelaySink, testEvent } from "../alerts/operatorEvents";
import { Installation } from "../install/installation";
import { LocalSmsOutbox, resetLocalSmsOutbox } from "../messaging/local/outbox";
import { PropertyWorkspace } from "../setup/workspace";
import { FileRuntimeStore } from "../storage/runtimeStore";
import { startSetupServer } from "../web/server";
import type { ToParent, ToWorker } from "./ipc";
import { SCRATCH_OUTBOX_FILE } from "./touringScratch";

/**
 * One touring host's Tour Core, as the shared service runs it. The service forks this file with the
 * host's environment (TOURCORE_DEPLOYMENT_MODE=TENANT_WORKER, the host's folder, number, and key),
 * forwards that host's calls, links, and texts to it on loopback, and delivers its landlord alerts.
 * It stops when the service does.
 */
export async function startTouringWorker(): Promise<void> {
  const send = process.send?.bind(process);
  if (!send) throw new Error("The touring process runs only under the shared service.");
  const tell = (message: ToParent) => void send(message);
  const log = (line: string) => tell({ type: "log", line });

  let alertsConnected = false;
  const relay = new RelaySink(tell, () => alertsConnected);
  const workspace = new PropertyWorkspace(process.env.TOURCORE_HOME);
  // A Scratch tenant's texts stay in a local outbox the shared service reads from this folder.
  if (process.env.TOURCORE_TOURING_SCRATCH === "1") resetLocalSmsOutbox(new LocalSmsOutbox(join(workspace.root, SCRATCH_OUTBOX_FILE)));
  const installation = new Installation({ root: workspace.root, runtime: new FileRuntimeStore(join(workspace.root, "runtime")), notificationSink: () => relay, log });
  installation.files.ensure({ deploymentMode: "TENANT_WORKER" });

  process.on("message", (raw) => {
    const message = raw as ToWorker;
    if (message.type === "event-ack") return relay.ack(message);
    if (message.type === "alerts") {
      const was = alertsConnected;
      alertsConnected = message.connected;
      // Like Cleaner Core, a newly connected routine gets one test event, so the host sees it work.
      if (!was && alertsConnected) {
        installation.outbox.enqueue(testEvent(new Date(installation.now())));
        void installation.outbox.drain().catch(() => undefined);
      }
    }
  });
  process.on("disconnect", () => process.exit(0));

  const { server } = await startSetupServer({ workspace, installation, host: "127.0.0.1", port: 0, open: false, log });
  const gate = await server.tourCore.storageReady;
  if (!gate.ok) {
    log(gate.summary);
    process.exit(1);
  }
  const address = server.address();
  tell({ type: "ready", port: typeof address === "object" && address ? address.port : 0 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startTouringWorker().catch((err) => {
    console.error(`  The touring process couldn't start: ${err instanceof Error ? err.message : "unknown error"}`);
    process.exit(1);
  });
}
