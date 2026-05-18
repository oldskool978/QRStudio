import os
import subprocess
import sys

def sanitize_path(path_str):
    return path_str.replace("\\", "/")

TOOLS_DIR = sanitize_path(os.path.dirname(os.path.abspath(__file__)))
BASE_DIR = sanitize_path(os.path.dirname(TOOLS_DIR))
BIN_DIR = sanitize_path(os.path.join(BASE_DIR, "bin"))

def run_cmd(cmd, cwd=None):
    print(f"[*] Executing: {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=cwd)
    if result.returncode != 0:
        print(f"[FATAL] Command failed: {' '.join(cmd)}")
        sys.exit(1)

def hydrate_node(name, url, sparse_paths=None):
    target_dir = sanitize_path(os.path.join(BIN_DIR, name))
    
    if os.path.exists(target_dir):
        print(f"[+] Node '{name}' already exists. Initiating upstream sync...")
        run_cmd(["git", "pull", "--rebase"], cwd=target_dir)
        return

    print(f"[+] Hydrating Node: {name} (Bleeding Edge)")
    
    if sparse_paths:
        run_cmd(["git", "clone", "--filter=blob:none", "--sparse", "--depth=1", url, target_dir])
        run_cmd(["git", "sparse-checkout", "set"] + sparse_paths, cwd=target_dir)
    else:
        run_cmd(["git", "clone", "--depth=1", url, target_dir])

def main():
    os.makedirs(BIN_DIR, exist_ok=True)
    
    try:
        subprocess.run(["git", "--version"], check=True, capture_output=True)
    except FileNotFoundError:
        print("[FATAL] Git executable not found in PATH.")
        sys.exit(1)

    # Core Decoding & Compression
    hydrate_node("zxing-cpp", "https://github.com/zxing-cpp/zxing-cpp.git")
    hydrate_node("zlib", "https://github.com/madler/zlib.git")

    print("\n[SYSTEM] Hydration Protocol Complete. All nodes converged to upstream latest.")

if __name__ == "__main__":
    main()