import os
import sys
import urllib.request
import tarfile
import zipfile
import shutil
import time
import stat

def sanitize_path(path_str):
    if not path_str: return ""
    return path_str.replace("\\", "/")

TOOLS_DIR = sanitize_path(os.path.dirname(os.path.abspath(__file__)))
BASE_DIR = sanitize_path(os.path.dirname(TOOLS_DIR))
BIN_DIR = sanitize_path(os.path.join(BASE_DIR, "bin"))

# ----------------------------------------------------------------------------
# UPSTREAM TOOLCHAIN REGISTRY
# ----------------------------------------------------------------------------
CMAKE_URL = "https://github.com/Kitware/CMake/releases/download/v3.31.2/cmake-3.31.2-windows-x86_64.zip"
NINJA_URL = "https://github.com/ninja-build/ninja/releases/download/v1.12.1/ninja-win.zip"
WASI_SDK_URL = "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-25/wasi-sdk-25.0-x86_64-windows.tar.gz"

# ----------------------------------------------------------------------------
# ROBUST I/O KERNEL ABSTRACTIONS
# ----------------------------------------------------------------------------
def clear_readonly_bit(func, path, _):
    """Forcefully strips the Read-Only attribute if Windows locks the file during rmtree."""
    os.chmod(path, stat.S_IWRITE)
    func(path)

def robust_rmtree(path, max_retries=7):
    """Deterministic spin-lock with exponential backoff for directory annihilation."""
    if not os.path.exists(path): return
    backoff = 0.2
    for attempt in range(max_retries):
        try:
            shutil.rmtree(path, onerror=clear_readonly_bit)
            return
        except OSError as e:
            if attempt == max_retries - 1:
                print(f"[FATAL] Persistent I/O Kernel Lock on {path}. Aborting.\n{e}")
                sys.exit(1)
            time.sleep(backoff)
            backoff *= 2

def robust_rename(src, dst, max_retries=7):
    """Deterministic spin-lock with exponential backoff for atomic directory translation."""
    backoff = 0.2
    for attempt in range(max_retries):
        try:
            os.rename(src, dst)
            return
        except OSError as e:
            if attempt == max_retries - 1:
                print(f"[FATAL] Persistent I/O Kernel Lock on {src}. Aborting.\n{e}")
                sys.exit(1)
            time.sleep(backoff)
            backoff *= 2

# ----------------------------------------------------------------------------
# HYDRATION PROTOCOL
# ----------------------------------------------------------------------------
def download_archive(url, dest):
    print(f"[SYSTEM] Fetching {url.split('/')[-1]}...")
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req) as response, open(dest, 'wb') as out_file:
        shutil.copyfileobj(response, out_file)

def hydrate_node(url, extract_dir, is_zip=False, rename_src=None, rename_dst=None):
    filename = url.split('/')[-1]
    archive_path = os.path.join(BIN_DIR, filename)

    if not os.path.exists(archive_path):
        download_archive(url, archive_path)

    print(f"[SYSTEM] Extracting {filename}...")
    if is_zip:
        with zipfile.ZipFile(archive_path, 'r') as zip_ref:
            zip_ref.extractall(extract_dir)
    else:
        with tarfile.open(archive_path, "r:gz") as tar_ref:
            tar_ref.extractall(extract_dir)

    os.remove(archive_path)

    if rename_src and rename_dst:
        src_path = os.path.join(extract_dir, rename_src)
        dst_path = os.path.join(extract_dir, rename_dst)
        
        if os.path.exists(dst_path):
            robust_rmtree(dst_path)
        
        # The extraction completes, the AV scans, we spin-lock until the kernel yields.
        robust_rename(src_path, dst_path)

def execute_hydration():
    os.makedirs(BIN_DIR, exist_ok=True)

    ninja_dir = os.path.join(BIN_DIR, "ninja")
    if not os.path.exists(os.path.join(ninja_dir, "ninja.exe")):
        os.makedirs(ninja_dir, exist_ok=True)
        hydrate_node(NINJA_URL, ninja_dir, is_zip=True)

    cmake_dir = os.path.join(BIN_DIR, "cmake")
    if not os.path.exists(os.path.join(cmake_dir, "bin", "cmake.exe")):
        hydrate_node(CMAKE_URL, BIN_DIR, is_zip=True, rename_src="cmake-3.31.2-windows-x86_64", rename_dst="cmake")

    wasi_dir = os.path.join(BIN_DIR, "wasi-sdk")
    if not os.path.exists(os.path.join(wasi_dir, "bin", "clang.exe")):
        hydrate_node(WASI_SDK_URL, BIN_DIR, is_zip=False, rename_src="wasi-sdk-25.0-x86_64-windows", rename_dst="wasi-sdk")

    print("[SYSTEM] Hermetic Toolchain Matrix Provisioned Successfully.")

if __name__ == "__main__":
    execute_hydration()