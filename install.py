#!/usr/bin/env python3

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
BACKEND_SRC = SCRIPT_DIR / "backend-plugin"
BACKEND_FILES = ["__init__.py", "plugin.yaml", "desktop/plugin.js"]

PLUGIN_ID = "hermes-insight"


def is_windows():
    return os.name == "nt" or sys.platform.startswith("win")


def _local_app_data():
    return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")


def gateway_plugins_dir():
    if is_windows():
        return _local_app_data() / "hermes" / "plugins"
    return Path.home() / ".hermes" / "plugins"


def plugin_targets(gateway_dir):
    return [gateway_dir / PLUGIN_ID / n for n in BACKEND_FILES]


def check_install(gateway_dir):
    targets = plugin_targets(gateway_dir)
    return [p for p in targets if p.exists()], [p for p in targets if not p.exists()]


def _copy(src, dst):
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    print(f"  copied {src.name} -> {dst}")


def install_backend(gateway_dir):
    print(f"\nBackend plugin -> {gateway_dir}")
    target_dir = gateway_dir / PLUGIN_ID
    for name in BACKEND_FILES:
        _copy(BACKEND_SRC / name, target_dir / name)


def enable_backend(no_enable):
    print(f"\nEnabling '{PLUGIN_ID}'...")
    if no_enable:
        print("  skipped (--no-enable)")
        return
    exe = shutil.which("hermes")
    if not exe:
        print(
            "  'hermes' CLI not found on PATH - skipped. "
            f"Add '{PLUGIN_ID}' to the plugins.enabled list in config.yaml instead."
        )
        return
    try:
        subprocess.run([exe, "plugins", "enable", PLUGIN_ID], check=True)
        print(f"  enabled '{PLUGIN_ID}'")
    except subprocess.CalledProcessError as e:
        print(f"  'hermes plugins enable {PLUGIN_ID}' failed (exit {e.returncode}).")
        print(f"  Add '{PLUGIN_ID}' to the plugins.enabled list in config.yaml instead.")
    except OSError as e:
        print(f"  could not run 'hermes' ({e}).")
        print(f"  Add '{PLUGIN_ID}' to the plugins.enabled list in config.yaml instead.")


def main():
    parser = argparse.ArgumentParser(
        description="Install the Insight plugin (backend + desktop half) for Hermes."
    )
    parser.add_argument(
        "--plugins", metavar="DIR",
        help="Hermes gateway plugins folder (default: auto-detected per platform)",
    )
    parser.add_argument(
        "--no-enable", action="store_true",
        help="Copy the files but do not run 'hermes plugins enable hermes-insight'",
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

    gateway = Path(args.plugins) if args.plugins else gateway_plugins_dir()

    print(f"Platform: {'Windows' if is_windows() else sys.platform}")
    print(f"Source:   {SCRIPT_DIR}")

    missing = [str(p) for p in (BACKEND_SRC / n for n in BACKEND_FILES) if not p.exists()]
    if missing:
        print("\nERROR: missing plugin source files:")
        for m in missing:
            print(f"  {m}")
        sys.exit(1)

    print(f"Backend target: {gateway}")

    found, not_found = check_install(gateway)
    total = len(found) + len(not_found)
    if found:
        print(f"\nExisting installation detected ({len(found)} of {total} files already in place):")
        for p in found:
            print(f"  {p}")
        if not_found:
            print("  (partially installed - missing files will be added)")

    if args.dry_run:
        print("\nDry run - would copy:")
        for name in BACKEND_FILES:
            print(f"  {BACKEND_SRC / name} -> {gateway / PLUGIN_ID / name}")
        print(f"  then run: hermes plugins enable {PLUGIN_ID}")
        return

    if len(found) == total and not args.force:
        answer = input("\nInsight is already installed. Reinstall (overwrite) anyway? [y/N] ").strip().lower()
        if answer not in ("y", "yes"):
            print("Skipping. Nothing was changed.")
            return

    install_backend(gateway)
    enable_backend(args.no_enable)

    print("\nVerifying installation...")
    found, not_found = check_install(gateway)
    for p in found:
        print(f"  ok  {p}")
    if not_found:
        print("ERROR: verification failed - the following files are missing:")
        for p in not_found:
            print(f"  {p}")
        sys.exit(1)

    print("\n  1. Restart the gateway: hermes gateway restart (if it was already running).")
    print("  2. Reload desktop plugins / restart Hermes Desktop.")
    print("  3. Verify:")
    print("       hermes insight --list-providers")

    print("\nInsight has been successfully installed, thank you for downloading!")


if __name__ == "__main__":
    main()