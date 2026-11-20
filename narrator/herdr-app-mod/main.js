import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, props, closeOverlay, home, readTextFile } from "herdr";

// The Narrator's spoken surface lives in its own hidden process (started by start.sh, listening on ~/.narrator/narrator.sock).
// This overlay is its remote: it runs the same plugin scripts the Herdr plugin does. Open it with mod.open:narrator.
// install.sh writes the plugin folder's path to ~/.narrator/plugin-dir, so this works from any checkout.
const pluginDir = async () => ((await readTextFile(`${home()}/.narrator/plugin-dir`)) ?? "").trim();
const ACTIONS = [
  { key: "r", label: "Replay last line", script: "send.sh", args: ["replay"] },
  { key: "m", label: "Toggle mute", script: "send.sh", args: ["mute"] },
  { key: "s", label: "Start the Narrator", script: "start.sh", args: [] },
  { key: "q", label: "Quit the Narrator", script: "send.sh", args: ["quit"] },
  { key: "x", label: "Restart the Narrator", script: "../restart.sh", args: [] },
];

export default class NarratorMod extends View {
  init(_props, cx) {
    this.muted = null;
    this.focus = cx.focus_handle();
    this.focus.focus();
    cx.spawn(async (cx) => {
      try {
        const s = JSON.parse((await readTextFile(`${home()}/.narrator/state.json`)) ?? "null");
        this.muted = Boolean(s?.NARRATOR_MUTED ?? s?.muted);
      } catch { this.muted = null; }
      cx.notify();
    });
  }

  act(a, cx) {
    closeOverlay(props().overlay);
    cx.spawn(async () => {
      try {
        const dir = await pluginDir();
        if (dir) await exec("sh", [`${dir}/${a.script}`, ...a.args]);
      } catch {}
    });
  }

  render(cx) {
    const t = theme();
    return v_flex().id("narrator").size_full().bg(t.popover).p(10).gap(4).track_focus(this.focus)
      .on_key_down((e, cx) => {
        const a = ACTIONS.find((x) => x.key === e.key);
        if (a) this.act(a, cx);
      })
      .child(h_flex().justify_between().text_size(12).text_color(t.muted)
        .child("Narrator")
        .child(this.muted === null ? "" : this.muted ? "muted" : "speaking"))
      .children(ACTIONS.map((a) =>
        h_flex().id(`g-${a.key}`).px(8).py(6).rounded(6).justify_between().text_size(13).text_color(t.foreground)
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.act(a, cx))
          .child(a.label)
          .child(div().text_color(t.dim).child(a.key))));
  }
}
