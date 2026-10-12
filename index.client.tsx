/**
 * Client entry: registers the Vibrancy settings screen, applies the saved CSS
 * vars on load, and — since the SDK's toast is a component-only hook, not an
 * imperative call from `contribute()` — shows update and rebuild notices as a
 * conditional sidebar item (`client/update-notice.ts`) pointing at a surface
 * that renders the same Vibrancy screen, instead of a toast.
 */

import type { PluginClientContext, PluginScreenProps } from "@getpaseo/plugin/client";
import type { PluginCleanup } from "@getpaseo/plugin";
import { ScrollView } from "@getpaseo/plugin/client/react-native";

import { getSettingsRpc } from "./shared/rpc.ts";
import { applyLiveSettings } from "./client/live-settings.ts";
import { watchUpdateNotice } from "./client/update-notice.ts";
import VibrancyScreen from "./client/VibrancyScreen.tsx";

/**
 * The sidebar notice opens a plain screen, which — unlike a settings screen —
 * gets no scroll container from the host, so without this the Build card
 * below Appearance and Terminal sits off the bottom of the window.
 */
function UpdateScreen(props: PluginScreenProps) {
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 24, paddingVertical: 16 }}>
      <VibrancyScreen {...props} />
    </ScrollView>
  );
}

export default function contribute(client: PluginClientContext): PluginCleanup {
  const settingsCleanup = client.addSettingsScreen({
    id: "vibrancy",
    title: "Vibrancy",
    icon: "Sparkles",
    Component: VibrancyScreen,
  });

  let disposed = false;

  client
    .rpc(getSettingsRpc, {})
    .then((settings) => {
      if (!disposed) {
        applyLiveSettings(settings);
      }
    })
    .catch((error: unknown) => {
      console.error("[vibrancy] getSettingsRpc failed on load", error);
    });

  const noticeCleanup = watchUpdateNotice(client, UpdateScreen);

  return () => {
    disposed = true;
    noticeCleanup();
    settingsCleanup();
  };
}
