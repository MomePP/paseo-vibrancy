export type HostPlatform = "darwin" | "win32";

/**
 * The OS the plugin server (and the patched Paseo it builds) runs on, from
 * Node's `process.platform`. Only meaningful on the server: the client can
 * run on a different device than the host it configures (a browser, a
 * phone), so it reads the host's platform from `vibrancy.status` instead.
 */
export const HOST_PLATFORM: HostPlatform =
  typeof process !== "undefined" && process.platform === "win32" ? "win32" : "darwin";
