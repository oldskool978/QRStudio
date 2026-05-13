import os
import sys
import platform
import stat
import urllib.request
import subprocess

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC_DIR = os.path.join(PROJECT_ROOT, "static")
TARGET_DIR = os.path.join(STATIC_DIR, "lib", "ui")
BIN_DIR = os.path.join(PROJECT_ROOT, "bin", "tailwind")

LUCIDE_URL = "https://unpkg.com/lucide@0.378.0/dist/umd/lucide.min.js"
TAILWIND_VERSION = "v3.4.3"

def get_tailwind_cli_url():
    system = platform.system().lower()
    machine = platform.machine().lower()
    
    if system == "windows":
        binary = "tailwindcss-windows-arm64.exe" if "arm" in machine else "tailwindcss-windows-x64.exe"
    elif system == "darwin":
        binary = "tailwindcss-macos-arm64" if "arm" in machine else "tailwindcss-macos-x64"
    else:
        binary = "tailwindcss-linux-arm64" if "arm" in machine or "aarch64" in machine else "tailwindcss-linux-x64"
        
    return f"https://github.com/tailwindlabs/tailwindcss/releases/download/{TAILWIND_VERSION}/{binary}", binary

def print_status(msg, status="INFO"):
    colors = {"INFO": "\033[94m", "SUCCESS": "\033[92m", "WARN": "\033[93m", "ERROR": "\033[91m", "RESET": "\033[0m"}
    print(f"{colors.get(status, '')}[{status}] {msg}{colors['RESET']}")

def download_file(url, dest):
    if os.path.exists(dest):
        return True
    try:
        headers = {"User-Agent": "Mozilla/5.0"}
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=30) as response, open(dest, 'wb') as out_file:
            out_file.write(response.read())
        return True
    except Exception as e:
        print_status(f"Network error fetching {url}: {e}", "ERROR")
        return False

def compile_css(cli_path):
    input_css = os.path.join(TARGET_DIR, "input.css")
    output_css = os.path.join(TARGET_DIR, "tailwind.css")
    
    with open(input_css, "w", encoding="utf-8") as f:
        f.write("@tailwind base;\n@tailwind components;\n@tailwind utilities;\n")
    
    content_glob = f"{STATIC_DIR}/*.html,{STATIC_DIR}/*.js"
    
    print_status("Initiating Tailwind AOT Compilation...", "INFO")
    cmd = [cli_path, "-i", input_css, "-o", output_css, "--content", content_glob, "--minify"]
    
    # SUPREMACY FIX: Gag the 'caniuse-lite' database warning for absolute console purity
    env = os.environ.copy()
    env["BROWSERSLIST_IGNORE_OLD_DATA"] = "1"
    
    try:
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
        os.remove(input_css)
        print_status(f"Static CSS Payload Compiled: {output_css}", "SUCCESS")
    except subprocess.CalledProcessError:
        print_status("CSS Compilation Failed.", "ERROR")
        sys.exit(1)

def main():
    print("="*60)
    print("       QR STUDIO UI STATIC HYDRATION PROTOCOL       ")
    print("="*60)

    os.makedirs(TARGET_DIR, exist_ok=True)
    os.makedirs(BIN_DIR, exist_ok=True)

    lucide_dest = os.path.join(TARGET_DIR, "lucide.min.js")
    if download_file(LUCIDE_URL, lucide_dest):
        print_status("Localized: lucide.min.js", "SUCCESS")
    else:
        sys.exit(1)

    cli_url, cli_filename = get_tailwind_cli_url()
    cli_dest = os.path.join(BIN_DIR, cli_filename)
    
    if download_file(cli_url, cli_dest):
        print_status(f"Localized CLI: {cli_filename}", "SUCCESS")
        if platform.system().lower() != "windows":
            os.chmod(cli_dest, os.stat(cli_dest).st_mode | stat.S_IEXEC)
    else:
        sys.exit(1)

    compile_css(cli_dest)
    
    old_cdn = os.path.join(TARGET_DIR, "tailwindcss.min.js")
    if os.path.exists(old_cdn):
        os.remove(old_cdn)

    print_status("UI Architecture is now strictly air-gapped and statically compiled.", "SUCCESS")

if __name__ == "__main__":
    main()