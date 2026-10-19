#!/usr/bin/env python3
"""Temporary, harmless GUI target for the opt-in real desktop acceptance test.

Run only when a user starts scripts/test-computer-live.mjs. Never reads/writes
user documents; records clicks and entry text in a caller-owned temporary file.
"""
from __future__ import annotations

import json
import os
import platform
import time
import tkinter as tk
from pathlib import Path

STATE_PATH = os.environ.get("DC_GUI_FIXTURE_STATE")
if not STATE_PATH:
    raise SystemExit("DC_GUI_FIXTURE_STATE must be set by the test runner")
state_file = Path(STATE_PATH)
root = tk.Tk()
root.title("DC Computer Use Acceptance Test")
root.geometry("500x300+220+140")
root.configure(bg="#f3f5fa")
status = {"ready": False, "clicked": 0, "typed": "", "pid": os.getpid()}
tk.Label(root, text="Computer Use acceptance test", font=("Helvetica", 16, "bold"),
         bg="#f3f5fa").place(x=45, y=25)
tk.Label(root, text="Temporary test window — no personal files", font=("Helvetica", 10),
         bg="#f3f5fa").place(x=45, y=60)
button = tk.Button(root, text="CLICK TEST BUTTON", font=("Helvetica", 13))
button.place(x=80, y=112, width=330, height=42)
tk.Label(root, text="INPUT TEST BOX", font=("Helvetica", 10),
         bg="#f3f5fa").place(x=80, y=175)
entry = tk.Entry(root, font=("Helvetica", 13))
entry.place(x=80, y=196, width=330, height=38)

def record() -> None:
    status.update(
        ready=True, timestamp=time.time(),
        button_x=button.winfo_rootx() + button.winfo_width() // 2,
        button_y=button.winfo_rooty() + button.winfo_height() // 2,
        input_x=entry.winfo_rootx() + entry.winfo_width() // 2,
        input_y=entry.winfo_rooty() + entry.winfo_height() // 2,
        typed=entry.get(),
    )
    temporary = state_file.with_suffix(".pending")
    temporary.write_text(json.dumps(status), encoding="utf-8")
    os.replace(temporary, state_file)

def on_click() -> None:
    status["clicked"] += 1
    record()

button.configure(command=on_click)
entry.bind("<KeyRelease>", lambda event: record())
entry.bind("<FocusIn>", lambda event: record())

root.update()
if platform.system() == "Darwin":
    # Normal window, not an always-on-top floating panel. A floating panel can
    # receive mouse events without becoming the keyboard-active application.
    from AppKit import NSApplication
    NSApplication.sharedApplication().activateIgnoringOtherApps_(True)
root.lift()
record()
root.after(150_000, root.destroy)
root.mainloop()
