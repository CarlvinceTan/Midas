import type { OpencodeClient } from "@opencode-ai/sdk";
import type { OpencodeClient as OpencodeV2Client } from "@opencode-ai/sdk/v2";
import { RemoteGateway } from "./gateway.ts";
import { startQuickTunnel, type RunningTunnel } from "./tunnel.ts";

export interface RemoteState {
  active: boolean;
  starting: boolean;
  url?: string;
  error?: string;
}

export interface RemoteManagerOptions {
  client: OpencodeClient;
  clientV2?: OpencodeV2Client;
  cwd: string;
  /** Read live so a /settings edit applies without restarting the TUI. */
  getPasswordHash: () => string | undefined;
  /** Called whenever the indicator should repaint. */
  onChange?: () => void;
}

/**
 * Owns the remote lifecycle for one midas process: the loopback gateway plus the
 * public Cloudflare Quick Tunnel. Sessions are shared with the TUI because the
 * gateway drives the same opencode server.
 */
export class RemoteManager {
  private gateway?: RemoteGateway;
  private tunnel?: RunningTunnel;
  private state: RemoteState = { active: false, starting: false };

  constructor(private readonly options: RemoteManagerOptions) {}

  get info(): RemoteState {
    return this.state;
  }

  get active(): boolean {
    return this.state.active;
  }

  get url(): string | undefined {
    return this.state.url;
  }

  hasPassword(): boolean {
    return Boolean(this.options.getPasswordHash());
  }

  /** Start the gateway and tunnel. Idempotent while already active. */
  async enable(): Promise<RemoteState> {
    if (this.state.active || this.state.starting) return this.state;
    if (!this.hasPassword()) throw new Error("Set a Remote password in /settings first");
    this.setState({ active: false, starting: true });
    try {
      const gateway = new RemoteGateway({
        client: this.options.client,
        clientV2: this.options.clientV2,
        cwd: this.options.cwd,
        getPasswordHash: this.options.getPasswordHash,
      });
      const port = await gateway.start();
      const tunnel = await startQuickTunnel(port);
      this.gateway = gateway;
      this.tunnel = tunnel;
      tunnel.proc.once("exit", () => {
        if (this.tunnel !== tunnel) return;
        this.tunnel = undefined;
        this.setState({ ...this.state, active: Boolean(this.gateway), error: "Public link closed. Run /remote refresh." });
      });
      this.setState({ active: true, starting: false, url: tunnel.url });
    } catch (error) {
      await this.gateway?.stop().catch(() => undefined);
      this.gateway = undefined;
      this.tunnel = undefined;
      const message = error instanceof Error ? error.message : String(error);
      this.setState({ active: false, starting: false, error: message });
      throw error;
    }
    return this.state;
  }

  /** Rotate the public URL without dropping the gateway or its sessions. */
  async refresh(): Promise<RemoteState> {
    if (!this.gateway) return this.enable();
    this.tunnel?.close();
    this.tunnel = undefined;
    this.setState({ active: true, starting: true });
    try {
      const tunnel = await startQuickTunnel(this.gateway.address);
      this.tunnel = tunnel;
      tunnel.proc.once("exit", () => {
        if (this.tunnel !== tunnel) return;
        this.tunnel = undefined;
        this.setState({ ...this.state, error: "Public link closed. Run /remote refresh." });
      });
      this.setState({ active: true, starting: false, url: tunnel.url });
    } catch (error) {
      this.setState({ active: true, starting: false, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    return this.state;
  }

  async disable(): Promise<void> {
    this.tunnel?.close();
    this.tunnel = undefined;
    const gateway = this.gateway;
    this.gateway = undefined;
    await gateway?.stop().catch(() => undefined);
    this.setState({ active: false, starting: false });
  }

  private setState(next: RemoteState): void {
    this.state = next;
    this.options.onChange?.();
  }
}
