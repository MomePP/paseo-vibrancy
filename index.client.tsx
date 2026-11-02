/**
 * The SDK's toast is hook-only (`useToast`), so update and rebuild notices are
 * a conditional sidebar item instead. Paseo runs this entry once per connected
 * host in one renderer, so it must never write per-device state into the
 * document; `pv.js` applies each device's appearance from its own settings file.
 */

import type { PluginClientContext, PluginScreenProps } from "@getpaseo/plugin/client";
import type { PluginCleanup } from "@getpaseo/plugin";
import { ScrollView } from "@getpaseo/plugin/client/react-native";

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

  const noticeCleanup = watchUpdateNotice(client, UpdateScreen);

  return () => {
    noticeCleanup();
    settingsCleanup();
  };
}
