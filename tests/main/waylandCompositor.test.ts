import { describe, expect, it } from "vitest";

import {
  detectCompositor,
  hyprGameOutputName,
  hyprGameWorkspace,
  hyprWorkspaceOnOutput,
  hyprTargetWorkspace,
  hyprMoveCommand,
  looksLikeWarframe,
  niriGameOutput,
  pickWarframeWindow,
  niriMoveRequests,
  niriWindowIdByTitle,
  swayGameOutput,
  swayMoveCommand,
} from "../../services/waylandCompositor";

const OVERLAY_TITLE = "WFHelper Relic Rewards";

describe("detectCompositor", () => {
  it("prefers a live compositor socket over nothing", () => {
    expect(detectCompositor({ NIRI_SOCKET: "/run/niri.sock" })).toEqual({
      kind: "niri",
      socketPath: "/run/niri.sock",
    });
    expect(detectCompositor({ SWAYSOCK: "/run/sway.sock" })?.kind).toBe("sway");
  });

  it("builds the hyprland path from the runtime dir and signature", () => {
    const found = detectCompositor({
      HYPRLAND_INSTANCE_SIGNATURE: "abc123",
      XDG_RUNTIME_DIR: "/run/user/1000",
    });
    expect(found?.kind).toBe("hyprland");
    expect(found?.socketPath.replace(/\\/g, "/")).toBe("/run/user/1000/hypr/abc123/.socket.sock");
  });

  it("is null with no compositor, and with a signature but no runtime dir", () => {
    expect(detectCompositor({})).toBeNull();
    expect(detectCompositor({ HYPRLAND_INSTANCE_SIGNATURE: "abc123" })).toBeNull();
  });
});

describe("looksLikeWarframe", () => {
  it("matches the name in any field, whatever its case", () => {
    expect(looksLikeWarframe("WARFRAME")).toBe(true);
    expect(looksLikeWarframe(null, "warframe.x64.exe")).toBe(true);
    expect(looksLikeWarframe("Terminal", "foot")).toBe(false);
    expect(looksLikeWarframe(61, { title: "Warframe" })).toBe(false);
  });

  it("matches the steam app id a native wayland window carries instead", () => {
    expect(looksLikeWarframe("", "steam_app_230410")).toBe(true);
    expect(looksLikeWarframe("", "STEAM_APP_230410")).toBe(true);
    expect(looksLikeWarframe("", "steam_app_230411")).toBe(false);
  });
});

describe("pickWarframeWindow", () => {
  const wiki = { title: "Warframe Wiki", appId: "firefox", activated: true };
  const game = { title: "Warframe", appId: "steam_app_230410", activated: false };

  it("prefers the game over a window that only mentions it", () => {
    expect(pickWarframeWindow([wiki, game])).toBe(game);
    expect(pickWarframeWindow([game, wiki])).toBe(game);
  });

  it("prefers an activated match, then a fullscreen one, then the first", () => {
    const idle = { title: "Warframe", appId: "warframe.x64.exe" };
    const shown = { title: "Warframe", appId: "warframe.x64.exe", fullscreen: true };
    const active = { title: "Warframe", appId: "warframe.x64.exe", activated: true };
    expect(pickWarframeWindow([idle, shown, active])).toBe(active);
    expect(pickWarframeWindow([idle, shown])).toBe(shown);
    expect(pickWarframeWindow([idle])).toBe(idle);
  });

  it("takes a weak match only when nothing stronger is there", () => {
    expect(pickWarframeWindow([wiki])).toBe(wiki);
    expect(pickWarframeWindow([{ title: "Terminal", appId: "foot" }])).toBeNull();
    expect(pickWarframeWindow([])).toBeNull();
  });
});

describe("niri", () => {
  const windows = [
    { id: 59, title: OVERLAY_TITLE, app_id: "wfhelper", workspace_id: 2 },
    { id: 61, title: "Warframe", app_id: "Warframe.x64.exe", workspace_id: 7 },
  ];
  const workspaces = [
    { id: 2, output: "DP-2" },
    { id: 7, output: "DP-1" },
  ];

  it("resolves the game's output through its workspace", () => {
    expect(niriGameOutput(windows, workspaces)).toBe("DP-1");
  });

  it("matches the game on app_id when the title is localised away", () => {
    const renamed = [{ id: 61, title: "Jeu", app_id: "warframe.x64.exe", workspace_id: 7 }];
    expect(niriGameOutput(renamed, workspaces)).toBe("DP-1");
  });

  it("is null when the game is absent or its workspace is unknown", () => {
    expect(niriGameOutput([windows[0]], workspaces)).toBeNull();
    expect(niriGameOutput(windows, [{ id: 2, output: "DP-2" }])).toBeNull();
  });

  it("finds our own window by its exact title only", () => {
    expect(niriWindowIdByTitle(windows, OVERLAY_TITLE)).toBe(59);
    expect(niriWindowIdByTitle(windows, "WFHelper Relic Planner")).toBeNull();
  });

  it("offers the newer action first and the field-free form as a fallback", () => {
    const [modern, legacy] = niriMoveRequests(59, "DP-1") as Array<Record<string, unknown>>;
    expect(modern).toEqual({
      Action: { MoveWindowToMonitor: { id: 59, output: "DP-1", focus: false } },
    });
    expect(legacy).toEqual({ Action: { MoveWindowToMonitor: { id: 59, output: "DP-1" } } });
  });
});

describe("sway", () => {
  const tree = {
    type: "root",
    name: "root",
    nodes: [
      {
        type: "output",
        name: "DP-1",
        nodes: [
          {
            type: "workspace",
            name: "1",
            nodes: [
              {
                type: "con",
                name: "Warframe",
                window_properties: { class: "Warframe.x64.exe", title: "Warframe" },
              },
            ],
          },
        ],
      },
      {
        type: "output",
        name: "DP-2",
        nodes: [],
        floating_nodes: [{ type: "floating_con", name: OVERLAY_TITLE, app_id: "wfhelper" }],
      },
    ],
  };

  it("returns the output enclosing the game node", () => {
    expect(swayGameOutput(tree)).toBe("DP-1");
  });

  it("finds a game sitting in the floating layer too", () => {
    const floating = {
      type: "root",
      nodes: [
        {
          type: "output",
          name: "HDMI-A-1",
          floating_nodes: [{ type: "floating_con", app_id: "warframe" }],
        },
      ],
    };
    expect(swayGameOutput(floating)).toBe("HDMI-A-1");
  });

  it("is null for an empty tree and for a tree with no game", () => {
    expect(swayGameOutput(null)).toBeNull();
    expect(
      swayGameOutput({ type: "root", nodes: [{ type: "output", name: "DP-2", nodes: [] }] }),
    ).toBeNull();
  });

  // An output named after a connector must never be mistaken for the game, or
  // every overlay would "find" it on whichever output happened to be first.
  it("does not treat an output's own name as a game match", () => {
    const named = {
      type: "root",
      nodes: [{ type: "output", name: "warframe-monitor", nodes: [] }],
    };
    expect(swayGameOutput(named)).toBeNull();
  });

  it("anchors the title so one overlay cannot match another", () => {
    expect(swayMoveCommand(OVERLAY_TITLE, "DP-1")).toBe(
      '[title="^WFHelper Relic Rewards$"] move window to output "DP-1"',
    );
  });
});

describe("hyprland", () => {
  const clients = [
    { title: OVERLAY_TITLE, class: "wfhelper", monitor: 1 },
    { title: "Warframe", class: "Warframe.x64.exe", monitor: 0 },
  ];
  const monitors = [
    { id: 0, activeWorkspace: { id: 3 } },
    { id: 1, activeWorkspace: { id: 5 } },
  ];

  it("resolves the workspace active on the game's monitor", () => {
    expect(hyprGameWorkspace(clients, monitors)).toBe(3);
  });

  it("is null when the game is absent or its monitor is unknown", () => {
    expect(hyprGameWorkspace([clients[0]], monitors)).toBeNull();
    expect(hyprGameWorkspace(clients, [{ id: 1, activeWorkspace: { id: 5 } }])).toBeNull();
  });

  it("is null when the monitor reports no active workspace", () => {
    expect(hyprGameWorkspace(clients, [{ id: 0, activeWorkspace: null }])).toBeNull();
  });

  it("turns a named output into the workspace live on it", () => {
    const named = [
      { id: 0, name: "DP-3", activeWorkspace: { id: 3 } },
      { id: 1, name: "DP-2", activeWorkspace: { id: 5 } },
    ];

    expect(hyprWorkspaceOnOutput(named, "DP-3")).toBe(3);
    expect(hyprWorkspaceOnOutput(named, "DP-2")).toBe(5);
    expect(hyprWorkspaceOnOutput(named, "HDMI-A-1")).toBeNull();
    expect(
      hyprWorkspaceOnOutput([{ id: 0, name: "DP-3", activeWorkspace: null }], "DP-3"),
    ).toBeNull();
  });

  it("falls back to the game's monitor for an output hyprland does not report", () => {
    const named = [
      { id: 0, name: "DP-3", activeWorkspace: { id: 3 } },
      { id: 1, name: "DP-2", activeWorkspace: { id: 5 } },
    ];

    expect(hyprTargetWorkspace(clients, named, "DP-2")).toBe(5);
    expect(hyprTargetWorkspace(clients, named, "HDMI-A-1")).toBe(3);
    expect(hyprTargetWorkspace(clients, named, null)).toBe(3);
    expect(hyprTargetWorkspace([clients[0]], named, "HDMI-A-1")).toBeNull();
  });

  // A layer surface is pinned by output name, not by workspace, so the same
  // client list has to answer both questions.
  it("names the monitor the game is on", () => {
    const named = [
      { id: 0, name: "DP-1", activeWorkspace: { id: 3 } },
      { id: 1, name: "DP-2", activeWorkspace: { id: 5 } },
    ];
    expect(hyprGameOutputName(clients, named)).toBe("DP-1");
  });

  it("has no output name when the game or its monitor is missing", () => {
    const named = [{ id: 1, name: "DP-2", activeWorkspace: { id: 5 } }];
    expect(hyprGameOutputName(clients, named)).toBeNull();
    expect(hyprGameOutputName([clients[0]], named)).toBeNull();
  });

  it("has no output name when the monitor reports none", () => {
    expect(hyprGameOutputName(clients, [{ id: 0, activeWorkspace: { id: 3 } }])).toBeNull();
  });

  it("targets our window by an anchored title regex", () => {
    expect(hyprMoveCommand(OVERLAY_TITLE, 3)).toBe(
      "dispatch movetoworkspacesilent 3,title:^(WFHelper Relic Rewards)$",
    );
  });
});
