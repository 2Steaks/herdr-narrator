import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, props, closeOverlay, home, readTextFile, notify } from "herdr";

// The Narrator's spoken surface lives in its own hidden process (started by start.sh, listening on ~/.narrator/narrator.sock).
// This overlay is its remote: it runs the same plugin scripts the Herdr plugin does. Open it with mod.open:narrator.
// install.sh writes the plugin folder's path to ~/.narrator/plugin-dir, so this works from any checkout.
const pluginDir = async () => ((await readTextFile(`${home()}/.narrator/plugin-dir`)) ?? "").trim();
// `report` actions run longer and post a toast with the result, since the overlay has closed by then.
const lastLine = (text) => text.trim().split("\n").pop().replace(/^\s*(ok|\.\.\.|FAIL)\s+/, "");
const ACTIONS = [
  { key: "r", label: "Replay last line", script: "send.sh", args: ["replay"] },
  { key: "m", label: "Toggle mute", script: "send.sh", args: ["mute"] },
  { key: "s", label: "Start the Narrator", script: "start.sh", args: [] },
  { key: "q", label: "Quit the Narrator", script: "send.sh", args: ["quit"] },
  {
    key: "x", label: "Restart the Narrator", script: "../restart.sh", args: [],
    report: { title: "Narrator restart", working: "Restarting...", timeout: 180000,
      result: (r) => (r.code === 0 ? { level: "success", body: lastLine(r.stdout) } : { level: "error", body: (r.stderr || r.stdout).trim().slice(0, 300) }) },
  },
  {
    // The full report is kept in ~/.narrator/doctor.txt; the toast shows the verdict and what to do about it.
    key: "d", label: "Diagnose problems", script: "../doctor.sh", args: [], tee: "doctor.txt",
    report: { title: "Narrator diagnosis", working: "Checking...", timeout: 60000,
      result: (r) => {
        const verdict = r.stdout.trim().split("\n\n").pop().slice(0, 400);
        const level = /Nothing wrong/.test(verdict) ? "success" : /^0 failure/.test(verdict) ? "warning" : "error";
        return { level, body: `${verdict}\nFull report: ~/.narrator/doctor.txt` };
      } },
  },
];

export default class NarratorMod extends View {
  init(_props, cx) {
    this.muted = null;
    this.busy = null;
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
    if (this.busy) return;
    const overlay = props().overlay;
    let closed = false;
    const close = () => { if (!closed) { closed = true; closeOverlay(overlay); } };
    // Closing the overlay cancels its tasks, so the command must start before it closes. Quick actions close once
    // the command is running; report actions stay open (showing their status) until their toast has been posted.
    cx.spawn(async (cx) => {
      try {
        const dir = await pluginDir();
        if (!dir) return;
        const script = `${dir}/${a.script}`;
        if (!a.report) {
          const run = exec("sh", [script, ...a.args]);
          close();
          await run;
          return;
        }
        this.busy = a.report.working;
        cx.notify();
        notify({ title: a.report.title, body: a.report.working, level: "info" });
        // tee keeps the whole output in a file next to config.env while the toast gets a summary of it
        const r = a.tee
          ? await exec("sh", ["-c", 'sh "$0" | tee "$HOME/.narrator/$1"', script, a.tee], { timeout: a.report.timeout })
          : await exec("sh", [script, ...a.args], { timeout: a.report.timeout });
        notify({ title: a.report.title, ...a.report.result(r) });
      } catch (e) {
        if (a.report) notify({ title: a.report.title, body: String(e?.message ?? e).slice(0, 200), level: "error" });
      } finally {
        close();
      }
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
        .child(this.busy ?? (this.muted === null ? "" : this.muted ? "muted" : "speaking")))
      .children(ACTIONS.map((a) =>
        h_flex().id(`g-${a.key}`).px(8).py(6).rounded(6).justify_between().text_size(13).text_color(t.foreground)
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.act(a, cx))
          .child(a.label)
          .child(div().text_color(t.dim).child(a.key))));
  }
}
