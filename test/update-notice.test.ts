import { mock, test } from "node:test";
import assert from "node:assert/strict";

import { RECHECK_INTERVAL_MS, watchUpdateNotice } from "../client/update-notice.ts";
import type { NoticeClient } from "../client/update-notice.ts";
import type { VibrancyStatus } from "../shared/rpc.ts";

function status(overrides: Partial<VibrancyStatus>): VibrancyStatus {
  return {
    runningVersion: "0.11.1",
    runningVibrancyBuild: true,
    builtFrom: "0.11.1",
    fingerprintMatches: true,
    ghosttyOverrides: [],
    latest: null,
    lastReport: [],
    lastError: null,
    building: false,
    progress: null,
    ...overrides,
  };
}

const release = (version: string) => ({ version, zipUrl: "", sha512: "", size: 0 });

/** A client whose server status is whatever `current` holds, recording the sidebar titles currently mounted. */
function fakeClient(initial: VibrancyStatus) {
  let current = initial;
  const sidebar = new Set<string>();
  const client = {
    rpc: async (contract: { name: string }) => (contract.name === "vibrancy.status" ? current : { release: null, error: null }),
    addScreen: () => () => {},
    addSidebarItem: ({ title }: { title: string }) => {
      sidebar.add(title);
      return () => sidebar.delete(title);
    },
  } as unknown as NoticeClient;
  return { client, sidebar, setStatus: (next: VibrancyStatus) => (current = next) };
}

async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

test("a release published after launch shows a notice on the next recheck", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const { client, sidebar, setStatus } = fakeClient(status({ latest: release("0.11.1") }));
    const cleanup = watchUpdateNotice(client, () => null);
    await settle();
    assert.deepEqual([...sidebar], []);

    setStatus(status({ latest: release("0.11.2") }));
    mock.timers.tick(RECHECK_INTERVAL_MS);
    await settle();
    assert.deepEqual([...sidebar], ["Paseo 0.11.2 available"]);

    setStatus(status({ latest: release("0.11.3") }));
    mock.timers.tick(RECHECK_INTERVAL_MS);
    await settle();
    assert.deepEqual([...sidebar], ["Paseo 0.11.3 available"]);

    cleanup();
    assert.deepEqual([...sidebar], []);
  } finally {
    mock.timers.reset();
  }
});

test("the notice clears once a recheck finds nothing to do", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const { client, sidebar, setStatus } = fakeClient(status({ fingerprintMatches: false }));
    const cleanup = watchUpdateNotice(client, () => null);
    await settle();
    assert.deepEqual([...sidebar], ["Vibrancy rebuild needed"]);

    setStatus(status({}));
    mock.timers.tick(RECHECK_INTERVAL_MS);
    await settle();
    assert.deepEqual([...sidebar], []);
    cleanup();
  } finally {
    mock.timers.reset();
  }
});
