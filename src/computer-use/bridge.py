#!/usr/bin/env python3
"""
One-shot local GUI bridge for DesktopCommanderMCP.
JSON request on stdin; JSON response on stdout. No shell evaluation.
Python 3 + PyAutoGUI + Pillow, launched from the desktop user's GUI session.
"""
from __future__ import annotations

import base64
import io
import json
import os
import platform
import subprocess
import sys
import time


def response(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=True))
    sys.stdout.flush()


def require_gui():
    try:
        import pyautogui as gui
    except Exception as exc:
        raise RuntimeError(
            "PyAutoGUI is not installed in the selected Python interpreter. "
            "Install python3 -m pip install pyautogui pillow in a venv "
            "and set DC_COMPUTER_PYTHON to its python executable."
        ) from exc
    gui.FAILSAFE = True  # moving the pointer to the top-left aborts the action
    gui.PAUSE = 0.08
    return gui


def clipboard_command(platform_name: str):
    if platform_name == "Darwin":
        return ["pbpaste"], ["pbcopy"], ["command", "v"]
    if platform_name == "Linux":
        return (
            ["xclip", "-selection", "clipboard", "-o"],
            ["xclip", "-selection", "clipboard", "-i"],
            ["ctrl", "v"],
        )
    raise RuntimeError("Unicode paste currently supports macOS and Linux X11 only")


def require_target_app_frontmost(x: int, y: int) -> int:
    """Fail closed if clicking a target did not activate its owning app.

    Synthetic macOS mouse clicks can hit non-activating floating windows while
    keyboard events still go to another foreground application. Determine the
    frontmost visible *normal window* beneath the screenshot point, and verify
    the application's PID is the system's active application before typing.
    """
    if platform.system() != "Darwin":
        return 0
    import AppKit
    import Quartz

    active = AppKit.NSWorkspace.sharedWorkspace().frontmostApplication()
    if active is None:
        raise RuntimeError("No foreground macOS application; refusing to type")
    pid = int(active.processIdentifier())
    owner_pid = None
    for window in Quartz.CGWindowListCopyWindowInfo(
            Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID):
        level = int(window.get("kCGWindowLayer", -1))
        if level < 0 or level >= 20 or float(window.get("kCGWindowAlpha", 1)) <= 0:
            continue
        bounds = window.get("kCGWindowBounds") or {}
        left, top = bounds.get("X"), bounds.get("Y")
        width, height = bounds.get("Width"), bounds.get("Height")
        if all(v is not None for v in (left, top, width, height)):
            if left <= x < left + width and top <= y < top + height:
                owner_pid = int(window.get("kCGWindowOwnerPID", 0))
                break
    if owner_pid is None or owner_pid <= 0:
        raise RuntimeError("Could not identify the visible target window; text not sent")
    if pid != owner_pid:
        raise RuntimeError(
            "The target window is not the foreground application. "
            "Activate its normal window first, then rescreenshot and retry; text not sent."
        )
    return owner_pid


def ensure_foreground(pid: int) -> None:
    if pid and platform.system() == "Darwin":
        from AppKit import NSWorkspace
        active = NSWorkspace.sharedWorkspace().frontmostApplication()
        if active is None or int(active.processIdentifier()) != pid:
            raise RuntimeError("Foreground application changed during typing; stopped")


def write_text(gui, text: str, expected_pid: int = 0) -> None:
    ensure_foreground(expected_pid)
    if platform.system() == "Darwin" and all(32 <= ord(char) <= 126 for char in text):
        # macOS IMEs can hold PyAutoGUI.write() keycodes as uncommitted text until
        # Return is pressed. Post explicit Unicode key events instead: they reach
        # text fields without triggering the active Japanese/Chinese IME.
        # Keep chunks small for CGEventKeyboardSetUnicodeString's event buffer.
        import Quartz
        for start in range(0, len(text), 16):
            piece = text[start:start + 16]
            down = Quartz.CGEventCreateKeyboardEvent(None, 0, True)
            up = Quartz.CGEventCreateKeyboardEvent(None, 0, False)
            Quartz.CGEventKeyboardSetUnicodeString(down, len(piece), piece)
            Quartz.CGEventKeyboardSetUnicodeString(up, len(piece), piece)
            Quartz.CGEventPost(Quartz.kCGHIDEventTap, down)
            time.sleep(0.015)
            Quartz.CGEventPost(Quartz.kCGHIDEventTap, up)
            time.sleep(0.015)
        return
    if platform.system() != "Darwin" and text.isascii():
        gui.write(text, interval=0.004)
        return
    # Non-ASCII / multiline text: temporarily replace the plain-text clipboard
    # and restore its *text*. Rich clipboard formats are not preserved;
    # see docs/COMPUTER_USE.md.
    read_cmd, write_cmd, paste_keys = clipboard_command(platform.system())
    old = subprocess.run(read_cmd, capture_output=True, check=True, timeout=4).stdout
    try:
        subprocess.run(write_cmd, input=text.encode("utf-8"), check=True, timeout=4)
        ensure_foreground(expected_pid)
        gui.hotkey(*paste_keys)
        time.sleep(0.25)
    finally:
        subprocess.run(write_cmd, input=old, check=True, timeout=4)


def list_windows() -> dict:
    os_name = platform.system()
    if os_name == "Darwin":
        script = """
tell application "System Events"
    set AppleScript's text item delimiters to linefeed
    set namesList to {}
    repeat with proc in (application processes whose background only is false)
        try
            repeat with win in (windows of proc)
                try
                    set end of namesList to ((name of proc as text) & " :: " & (name of win as text))
                end try
            end repeat
        end try
    end repeat
    return namesList as text
end tell
"""
        cmd = ["osascript", "-e", script]
    elif os_name == "Linux":
        if os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland":
            raise RuntimeError("Wayland window enumeration is not implemented; use X11")
        cmd = ["wmctrl", "-l"]
    else:
        raise RuntimeError("Window enumeration is supported only on macOS and X11 Linux")

    try:
        result = subprocess.run(cmd, capture_output=True, check=True, timeout=9, text=True)
    except FileNotFoundError as exc:
        raise RuntimeError("The window enumeration utility is missing (Linux: install wmctrl)") from exc
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            "Cannot enumerate windows; check desktop session and Accessibility permissions: "
            + (exc.stderr or "")[:400]
        ) from exc
    return {"ok": True, "windows": [x.strip() for x in result.stdout.splitlines() if x.strip()][:200]}


def main():
    payload = json.load(sys.stdin)
    action = payload.get("action")
    if action == "list_windows":
        return list_windows()

    if platform.system() == "Linux" and os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland":
        raise RuntimeError("Computer Use MVP currently supports X11, not Wayland; switch desktop session or add a Wayland portal backend")

    gui = require_gui()
    logical_width, logical_height = map(int, gui.size())
    base = {
        "ok": True, "platform": platform.system(),
        "logical_width": logical_width, "logical_height": logical_height,
    }

    if action == "screen_info":
        return {**base, "primary_display_only": True, "display": os.environ.get("DISPLAY", "")}
    if action == "screenshot":
        screenshot = gui.screenshot()
        buffer = io.BytesIO()
        screenshot.convert("RGB").save(buffer, format="JPEG", quality=88)
        return {
            **base,
            "pixel_width": screenshot.width, "pixel_height": screenshot.height,
            "image_base64": base64.b64encode(buffer.getvalue()).decode("ascii"),
        }

    if action == "click":
        gui.click(x=int(payload["x"]), y=int(payload["y"]),
                  clicks=int(payload.get("clicks", 1)), interval=0.12,
                  button=payload.get("button", "left"))
    elif action == "type":
        # Focusing and typing in one native process prevents focus from moving
        # between separate screenshot/click/type calls on macOS desktops.
        if ("x" in payload) != ("y" in payload):
            raise ValueError("Both x and y are required when targeting text")
        expected_pid = 0
        if "x" in payload:
            x, y = int(payload["x"]), int(payload["y"])
            gui.click(x=x, y=y)
            time.sleep(0.25)
            expected_pid = require_target_app_frontmost(x, y)
        write_text(gui, str(payload["text"]), expected_pid)
    elif action == "key":
        aliases = {"cmd": "command", "control": "ctrl", "option": "alt",
                   "escape": "esc", "return": "enter", "super": "win"}
        keys = [aliases.get(str(k).lower(), str(k).lower()) for k in payload["keys"]]
        if any(k not in gui.KEYBOARD_KEYS for k in keys):
            raise ValueError("Unsupported keyboard key; use PyAutoGUI key names")
        gui.hotkey(*keys, interval=0.07)
    elif action == "scroll":
        gui.scroll(int(payload["clicks"]),
                   x=int(payload["x"]), y=int(payload["y"]))
    elif action == "drag":
        gui.moveTo(int(payload["from_x"]), int(payload["from_y"]))
        gui.dragTo(int(payload["to_x"]), int(payload["to_y"]),
                   duration=float(payload.get("duration_ms", 450)) / 1000,
                   button="left")
    else:
        raise ValueError("Unknown action: " + str(action))

    return {**base, "action": action, "applied": True}


if __name__ == "__main__":
    try:
        response(main())
    except Exception as error:
        # Never print tracebacks or GUI contents to stdout; MCP expects JSON.
        response({"ok": False, "error": type(error).__name__ + ": " + str(error)[:550]})
