/**
 * The sidebar notice for a newer Paseo release or a stale build. It rechecks
 * on an interval, not only at load: the client contributes once per renderer
 * launch, and Paseo often stays open for days, so a release published after
 * launch would otherwise never surface until the next restart.
 */

import type { ComponentType } from "react";
import type { PluginClientContext, PluginScreenProps } from "@getpaseo/plugin/client";
import type { PluginCleanup } from "@getpaseo/plugin";

import { checkUpdateRpc, statusRpc } from "../shared/rpc.ts";
import type { VibrancyStatus } from "../shared/rpc.ts";
import { compareVersions } from "../shared/version.ts";

export const UPDATE_SURFACE_ID = "vibrancy-update";

/** Hourly keeps each client at two unauthenticated GitHub requests an hour, well under the 60/h limit. */
export const RECHECK_INTERVAL_MS = 60 * 60 * 1000;

export type NoticeClient = Pick<PluginClientContext, "rpc" | "addScreen" | "addSidebarItem">;

export function updateNoticeTitle(status: VibrancyStatus): string | null {
  if (status.latest !== null && status.runningVersion !== null) {
    if (compareVersions(status.latest.version, status.runningVersion) > 0) {
      return `Paseo ${status.latest.version} available`;
    }
  }
  if (status.runningVibrancyBuild && !status.fingerprintMatches) {
    return "Vibrancy rebuild needed";
  }
  return null;
}

/** Checks now and every `intervalMs`, showing, retitling, or removing the sidebar notice to match the latest status. */
export function watchUpdateNotice(
  client: NoticeClient,
  Screen: ComponentType<PluginScreenProps>,
  intervalMs: number = RECHECK_INTERVAL_MS,
): PluginCleanup {
  let disposed = false;
  let shownTitle: string | null = null;
  let removeNotice: PluginCleanup | null = null;

  function show(title: string | null) {
    if (title === shownTitle) {
      return;
    }
    removeNotice?.();
    removeNotice = null;
    shownTitle = title;
    if (title === null) {
      return;
    }
    const surfaceCleanup = client.addScreen({ id: UPDATE_SURFACE_ID, title: "Vibrancy", Component: Screen });
    const sidebarCleanup = client.addSidebarItem({ id: UPDATE_SURFACE_ID, title, icon: "Sparkles", surface: UPDATE_SURFACE_ID });
    removeNotice = () => {
      sidebarCleanup();
      surfaceCleanup();
    };
  }

  async function refresh() {
    try {
      await client.rpc(checkUpdateRpc, {});
    } catch (error) {
      console.error("[vibrancy] checkUpdateRpc failed", error);
    }
    if (disposed) {
      return;
    }
    try {
      const status = await client.rpc(statusRpc, {});
      if (!disposed) {
        show(updateNoticeTitle(status));
      }
    } catch (error) {
      console.error("[vibrancy] statusRpc failed", error);
    }
  }

  void refresh();
  const timer = setInterval(() => void refresh(), intervalMs);

  return () => {
    disposed = true;
    clearInterval(timer);
    removeNotice?.();
  };
}
