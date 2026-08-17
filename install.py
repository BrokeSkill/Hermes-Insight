#!/usr/bin/env python3

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
RENDERER_SRC = SCRIPT_DIR / "renderer-plugin" / "plugin.js"
BACKEND_FILES = ["__init__.py", "plugin.yaml"]

PLUGIN_ID = "insight"
BACKEND_ID = "insight-backend"


def is_windows():
    return os.name == "nt" or sys.platform.startswith("win")


def _local_app_data():
    return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")


def desktop_plugins_dir():
    if is_windows():
        return _local_app_data() / "hermes" / "desktop-plugins"
    xdg = os.environ.get("XDG_DATA_HOME")
    base = Path(xdg) if xdg else Path.home() / ".local" / "share"
    return base / "hermes" / "desktop-plugins"


def gateway_plugins_dir():
    if is_windows():
        return _local_app_data() / "hermes" / "plugins"
    return Path.home() / ".hermes" / "plugins"


def plugin_targets(desktop_dir, gateway_dir):
    renderer = desktop_dir / PLUGIN_ID / "plugin.js"
    backend = [gateway_dir / BACKEND_ID / n for n in BACKEND_FILES]
    return renderer, backend


def check_install(desktop_dir, gateway_dir):
    renderer, backend = plugin_targets(desktop_dir, gateway_dir)
    targets = [renderer] + backend
    found = [p for p in targets if p.exists()]
    return found, [p for p in targets if not p.exists()]


def _copy(src, dst):
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    print(f"  copied {src.name} -> {dst}")


def install_renderer(desktop_dir):
    print(f"\nRenderer plugin -> {desktop_dir}")
    target = desktop_dir / PLUGIN_ID / "plugin.js"
    _copy(RENDERER_SRC, target)


def install_backend(gateway_dir):
    print(f"\nBackend plugin -> {gateway_dir}")
    target_dir = gateway_dir / BACKEND_ID
    for name in BACKEND_FILES:
        _copy(SCRIPT_DIR / "backend-plugin" / name, target_dir / name)


def enable_backend(no_enable):
    print(f"\nEnabling '{BACKEND_ID}'...")
    if no_enable:
        print("  skipped (--no-enable)")
        return
    exe = shutil.which("hermes")
    if not exe:
        print(
            "  'hermes' CLI not found on PATH - skipped. "
            "Add 'insight-backend' to the plugins.enabled list in config.yaml instead."
        )
        return
    try:
        subprocess.run([exe, "plugins", "enable", BACKEND_ID], check=True)
        print(f"  enabled '{BACKEND_ID}'")
    except subprocess.CalledProcessError as e:
        print(f"  'hermes plugins enable {BACKEND_ID}' failed (exit {e.returncode}).")
        print("  Add 'insight-backend' to the plugins.enabled list in config.yaml instead.")
    except OSError as e:
        print(f"  could not run 'hermes' ({e}).")
        print("  Add 'insight-backend' to the plugins.enabled list in config.yaml instead.")


def main():
    parser = argparse.ArgumentParser(
        description="Install the Insight plugin (renderer + backend) for Hermes Desktop."
    )
    parser.add_argument(
        "--desktop-plugins", metavar="DIR",
        help="Hermes Desktop plugins folder (default: auto-detected per platform)",
    )
    parser.add_argument(
        "--plugins", metavar="DIR",
        help="Hermes gateway plugins folder (default: auto-detected per platform)",
    )
    parser.add_argument(
        "--no-enable", action="store_true",
        help="Copy the files but do not run 'hermes plugins enable insight-backend'",
    )
    parser.add_argument(
        "--force", action="store_true",
        help="Reinstall without asking even if Insight is already installed",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print what would be installed without copying anything",
    )
    args = parser.parse_args()

    desktop = Path(args.desktop_plugins) if args.desktop_plugins else desktop_plugins_dir()
    gateway = Path(args.plugins) if args.plugins else gateway_plugins_dir()

    print(f"Platform: {'Windows' if is_windows() else sys.platform}")
    print(f"Source:   {SCRIPT_DIR}")

    missing = [str(p) for p in ([RENDERER_SRC] + [SCRIPT_DIR / "backend-plugin" / n for n in BACKEND_FILES]) if not p.exists()]
    if missing:
        print("\nERROR: missing plugin source files:")
        for m in missing:
            print(f"  {m}")
        sys.exit(1)

    print(f"Renderer target: {desktop}")
    print(f"Backend target:  {gateway}")

    found, not_found = check_install(desktop, gateway)
    total = len(found) + len(not_found)
    if found:
        print(f"\nExisting installation detected ({len(found)} of {total} files already in place):")
        for p in found:
            print(f"  {p}")
        if not_found:
            print("  (partially installed - missing files will be added)")

    if args.dry_run:
        print(f"\nDry run - would copy:")
        print(f"  {RENDERER_SRC} -> {desktop / PLUGIN_ID / 'plugin.js'}")
        for name in BACKEND_FILES:
            print(f"  {SCRIPT_DIR / 'backend-plugin' / name} -> {gateway / BACKEND_ID / name}")
        print("  then run: hermes plugins enable insight-backend")
        return

    if len(found) == total and not args.force:
        answer = input("\nInsight is already installed. Reinstall (overwrite) anyway? [y/N] ").strip().lower()
        if answer not in ("y", "yes"):
            print("Skipping. Nothing was changed.")
            return

    install_renderer(desktop)
    install_backend(gateway)
    enable_backend(args.no_enable)

    print("\nVerifying installation...")
    found, not_found = check_install(desktop, gateway)
    for p in found:
        print(f"  ok  {p}")
    if not_found:
        print("ERROR: verification failed - the following files are missing:")
        for p in not_found:
            print(f"  {p}")
        sys.exit(1)

    print("\n  1. Restart Hermes Desktop / reload desktop plugins.")
    print("  2. Restart the gateway: hermes gateway restart (if it was already running).")
    print("  3. Verify:")
    print("       hermes insight --sse-url")
    print("       hermes insight --list-providers")

    print("\nInsight has been successfully installed, thank you for downloading!")


if __name__ == "__main__":
    main()
