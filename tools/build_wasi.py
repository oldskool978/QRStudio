import os
import sys
import subprocess
import shutil
import re

def sanitize_path(path_str):
    if not path_str: return ""
    return path_str.replace("\\", "/")

TOOLS_DIR = sanitize_path(os.path.dirname(os.path.abspath(__file__)))
BASE_DIR = sanitize_path(os.path.dirname(TOOLS_DIR))
BIN_DIR = sanitize_path(os.path.join(BASE_DIR, "bin"))
SYSROOT_DIR = sanitize_path(os.path.join(BIN_DIR, "wasi-sysroot"))

POLYFILL_DIR = sanitize_path(os.path.join(BIN_DIR, "wasi_polyfills"))
POLYFILL_H = sanitize_path(os.path.join(POLYFILL_DIR, "wasi_polyfill.h"))
DUMMY_INC = sanitize_path(os.path.join(POLYFILL_DIR, "include"))

CMAKE_EXE = sanitize_path(os.path.join(BIN_DIR, "cmake", "bin", "cmake.exe"))
NINJA_EXE = sanitize_path(os.path.join(BIN_DIR, "ninja", "ninja.exe"))
CLANG_EXE = sanitize_path(os.path.join(BIN_DIR, "wasi-sdk", "bin", "clang.exe"))
CLANGXX_EXE = sanitize_path(os.path.join(BIN_DIR, "wasi-sdk", "bin", "clang++.exe"))
LLVM_AR = sanitize_path(os.path.join(BIN_DIR, "wasi-sdk", "bin", "llvm-ar.exe"))
TOOLCHAIN_FILE = sanitize_path(os.path.join(TOOLS_DIR, "wasi_toolchain.cmake"))

ZLIB_DIR = sanitize_path(os.path.join(BIN_DIR, "zlib"))
ZXING_DIR = sanitize_path(os.path.join(BIN_DIR, "zxing-cpp"))

SRC_WASM_DIR = sanitize_path(os.path.join(BASE_DIR, "src_wasm"))
PAYLOAD_BUILD_DIR = sanitize_path(os.path.join(SRC_WASM_DIR, "build"))

def verify_hermetic_toolchain():
    missing = []
    for tool, path in [("CMake", CMAKE_EXE), ("Ninja", NINJA_EXE), ("Clang", CLANG_EXE)]:
        if not os.path.exists(path): missing.append(path)
    if missing:
        print("[FATAL] Strict Hermetic Constraint Violated.")
        sys.exit(1)

CORE_CMAKE_ARGS = [
    CMAKE_EXE, "-G", "Ninja",
    f"-DCMAKE_TOOLCHAIN_FILE={TOOLCHAIN_FILE}",
    f"-DCMAKE_MAKE_PROGRAM={NINJA_EXE}",
    f"-DCMAKE_C_COMPILER={CLANG_EXE}",
    f"-DCMAKE_CXX_COMPILER={CLANGXX_EXE}",
    f"-DCMAKE_SYSROOT={SYSROOT_DIR}"
]

def forge_toolchain_matrix():
    toolchain_content = f"""set(CMAKE_SYSTEM_NAME Generic)
set(CMAKE_SYSTEM_PROCESSOR wasm32)
set(CMAKE_C_COMPILER_TARGET wasm32-wasip1)
set(CMAKE_CXX_COMPILER_TARGET wasm32-wasip1)
set(CMAKE_C_COMPILER_WORKS 1)
set(CMAKE_CXX_COMPILER_WORKS 1)
set(WASM_SJLJ "-fwasm-exceptions -mllvm -wasm-enable-sjlj")
set(WASI_EXTRAS "-D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_SIGNAL -D_GNU_SOURCE -Wno-implicit-function-declaration -I{DUMMY_INC} -I{SYSROOT_DIR}/include -include {POLYFILL_H}")
set(OPT_FLAGS "-O3 -flto -msimd128 -mbulk-memory -fvisibility=hidden -fvisibility-inlines-hidden ${{WASM_SJLJ}} ${{WASI_EXTRAS}} -Wno-deprecated-declarations")
set(CMAKE_C_FLAGS_INIT "${{OPT_FLAGS}}")
set(CMAKE_CXX_FLAGS_INIT "${{OPT_FLAGS}} -Wno-nontrivial-memaccess -stdlib=libc++")
set(CMAKE_EXE_LINKER_FLAGS_INIT "-O3 -flto -msimd128 -mbulk-memory ${{WASM_SJLJ}} -fuse-ld=lld")
set(CMAKE_SHARED_LINKER_FLAGS_INIT "${{CMAKE_EXE_LINKER_FLAGS_INIT}}")
set(CMAKE_MODULE_LINKER_FLAGS_INIT "${{CMAKE_EXE_LINKER_FLAGS_INIT}}")
set(CMAKE_C_STANDARD_LIBRARIES "-lwasi-emulated-process-clocks -lwasi-emulated-signal -lwasi-polyfill")
set(CMAKE_CXX_STANDARD_LIBRARIES "${{CMAKE_C_STANDARD_LIBRARIES}}")
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
"""
    with open(TOOLCHAIN_FILE, "w", encoding="utf-8") as f:
        f.write(toolchain_content)

def forge_universal_polyfill():
    os.makedirs(os.path.join(DUMMY_INC, "sys"), exist_ok=True)
    os.makedirs(os.path.join(DUMMY_INC, "arpa"), exist_ok=True)
    os.makedirs(os.path.join(DUMMY_INC, "netinet"), exist_ok=True)
    
    for h in ["netdb.h", "sys/socket.h", "sys/select.h", "arpa/inet.h", "netinet/in.h", "mutex", "thread", "condition_variable", "shared_mutex", "future"]:
        with open(os.path.join(DUMMY_INC, h), "w") as f: f.write("#pragma once\n")

    with open(os.path.join(DUMMY_INC, "pwd.h"), "w", encoding="utf-8") as f:
        f.write("#pragma once\n#ifdef __cplusplus\nextern \"C\" {\n#endif\n"
                "struct passwd { char* pw_dir; char* pw_name; };\n"
                "static inline struct passwd* getpwuid(int uid) { return (struct passwd*)0; }\n"
                "static inline struct passwd* getpwnam(const char* name) { return (struct passwd*)0; }\n"
                "#ifdef __cplusplus\n}\n#endif\n")

    with open(POLYFILL_H, "w") as f:
        f.write(
            "#pragma once\n#undef GRAPHICS_DISABLED\n#define GRAPHICS_DISABLED 1\n"
            "#ifdef __cplusplus\n#include <fstream>\n#include <filesystem>\n#include <functional>\n#include <utility>\n"
            "#define recursive_directory_iterator directory_iterator\n"
            "namespace std {\n"
            "    class wasi_mutex { public: void lock(){} void unlock(){} bool try_lock(){return true;} };\n"
            "    class wasi_recursive_mutex { public: void lock(){} void unlock(){} bool try_lock(){return true;} };\n"
            "    template <typename T> class wasi_lock_guard { public: wasi_lock_guard(T&) {} };\n"
            "    template <typename... T> class wasi_scoped_lock { public: wasi_scoped_lock(T&...) {} };\n"
            "    template <typename T> class wasi_unique_lock { public: wasi_unique_lock(T&) {} void lock(){} void unlock(){} };\n"
            "    class wasi_condition_variable { public: void notify_all(){} void notify_one(){} template<typename T> void wait(T&){} };\n"
            "    struct wasi_once_flag { bool flag = false; };\n"
            "    template<class Callable, class... Args>\n"
            "    void wasi_call_once(wasi_once_flag& flag, Callable&& func, Args&&... args) {\n"
            "        if (!flag.flag) { std::invoke(std::forward<Callable>(func), std::forward<Args>(args)...); flag.flag = true; }\n"
            "    }\n"
            "    class wasi_thread { public: wasi_thread() {} template<class Function, class... Args> explicit wasi_thread(Function&& f, Args&&... args) { std::invoke(std::forward<Function>(f), std::forward<Args>(args)...); } void join() {} bool joinable() const { return false; } void detach() {} };\n"
            "    namespace wasi_this_thread { inline void yield() {} }\n}\n"
            "#define mutex wasi_mutex\n#define recursive_mutex wasi_recursive_mutex\n#define lock_guard wasi_lock_guard\n"
            "#define scoped_lock wasi_scoped_lock\n#define unique_lock wasi_unique_lock\n#define condition_variable wasi_condition_variable\n"
            "#define once_flag wasi_once_flag\n#define call_once wasi_call_once\n#define thread wasi_thread\n#define this_thread wasi_this_thread\n#endif\n"
        )

    stubs_cpp = os.path.join(POLYFILL_DIR, "wasi_abi_stubs.cpp")
    with open(stubs_cpp, "w") as f:
        f.write("#include <cstddef>\nextern \"C\" {\n"
                "int mkstemp(char* tmpl) { return -1; }\n"
                "int mkostemp(char* tmpl, int flags) { return -1; }\n"
                "}\n")

    stub_obj = os.path.join(POLYFILL_DIR, "wasi_abi_stubs.o")
    stub_lib = sanitize_path(os.path.join(SYSROOT_DIR, "lib", "wasm32-wasip1", "libwasi-polyfill.a"))
    
    if os.path.exists(stub_lib): os.remove(stub_lib)
    if os.path.exists(stub_obj): os.remove(stub_obj)
    
    os.makedirs(os.path.dirname(stub_lib), exist_ok=True)
    subprocess.run([CLANGXX_EXE, "-c", "-O3", "-fwasm-exceptions", "--target=wasm32-wasip1", f"--sysroot={SYSROOT_DIR}", stubs_cpp, "-o", stub_obj], check=True)
    subprocess.run([LLVM_AR, "rcs", stub_lib, stub_obj], check=True)

def forge_sysroot_and_runtime():
    sdk_sysroot = sanitize_path(os.path.join(BIN_DIR, "wasi-sdk", "share", "wasi-sysroot"))
    if not os.path.exists(SYSROOT_DIR):
        shutil.copytree(sdk_sysroot, SYSROOT_DIR)
    forge_universal_polyfill()

def apply_hermetic_patches():
    zlib_cmake = os.path.join(ZLIB_DIR, "CMakeLists.txt")
    if os.path.exists(zlib_cmake):
        minimal_cmake = """cmake_minimum_required(VERSION 3.10)
project(zlib C)
set(ZLIB_SRCS adler32.c compress.c crc32.c deflate.c gzclose.c gzlib.c gzread.c gzwrite.c inflate.c infback.c inftrees.c inffast.c trees.c uncompr.c zutil.c)
add_library(zlib STATIC ${ZLIB_SRCS})
target_include_directories(zlib PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
set_target_properties(zlib PROPERTIES OUTPUT_NAME z)
install(TARGETS zlib DESTINATION lib)
install(FILES zlib.h zconf.h DESTINATION include)
"""
        with open(zlib_cmake, "w", encoding="utf-8") as f: f.write(minimal_cmake)

    zxing_root_cmake = os.path.join(ZXING_DIR, "CMakeLists.txt")
    if os.path.exists(zxing_root_cmake):
        with open(zxing_root_cmake, "r", encoding="utf-8") as f: data = f.read()
        data = re.sub(r'(?mi)^\s*add_subdirectory\s*\(\s*(example|test|wrappers|docs?)[^)]*\).*$', '', data)
        with open(zxing_root_cmake, "w", encoding="utf-8") as f: f.write(data)

    zxing_core_cmake = os.path.join(ZXING_DIR, "core", "CMakeLists.txt")
    if os.path.exists(zxing_core_cmake):
        with open(zxing_core_cmake, "r", encoding="utf-8") as f: data = f.read()
        data = re.sub(r'(?i)find_package\s*\(\s*Threads\s+REQUIRED\s*\)', 'add_library(Threads::Threads INTERFACE IMPORTED)', data)
        with open(zxing_core_cmake, "w", encoding="utf-8") as f: f.write(data)

def execute_build_node(expected_lib, src_dir, extra_cmake_args):
    if os.path.exists(f"{SYSROOT_DIR}/lib/{expected_lib}"): return

    build_dir = f"{src_dir}/build_wasi"
    os.makedirs(build_dir, exist_ok=True)
    
    cmd_cmake = CORE_CMAKE_ARGS + [
        f"-DCMAKE_INSTALL_PREFIX={SYSROOT_DIR}",
        f"-DCMAKE_PREFIX_PATH={SYSROOT_DIR}",
        "-DCMAKE_INSTALL_LIBDIR=lib",
        "-DBUILD_SHARED_LIBS=OFF",
        "-Wno-dev"
    ] + extra_cmake_args + ["-S", src_dir, "-B", build_dir]
    
    subprocess.run(cmd_cmake, check=True)
    subprocess.run([NINJA_EXE, "-C", build_dir, "install"], check=True)

def forge_dependency_graph():
    apply_hermetic_patches()
    execute_build_node("libz.a", ZLIB_DIR, [])
    execute_build_node("libZXing.a", ZXING_DIR, [
        "-DZXING_C_API=OFF",
        "-DZXING_PYTHON_MODULE=OFF",
        "-DZXING_EXAMPLES=OFF",
        "-DZXING_BLACKBOX_TESTS=OFF",
        "-DZXING_UNIT_TESTS=OFF",
        "-DZXING_DEPENDENCIES=LOCAL",
        "-DZXING_WRITERS=OLD"
    ])

def compile_payload():
    core_src = os.path.join(SRC_WASM_DIR, "transpiler_core.cpp")
    cmake_src = os.path.join(SRC_WASM_DIR, "CMakeLists.txt")
    
    if not os.path.exists(core_src) or not os.path.exists(cmake_src):
        print(f"[FATAL] Source matrix missing. Ensure {core_src} and {cmake_src} exist.")
        sys.exit(1)

    if os.path.exists(PAYLOAD_BUILD_DIR): shutil.rmtree(PAYLOAD_BUILD_DIR, ignore_errors=True)
    os.makedirs(PAYLOAD_BUILD_DIR, exist_ok=True)
    
    cmd_cmake = CORE_CMAKE_ARGS + ["-DBUILD_SHARED_LIBS=OFF", "-S", SRC_WASM_DIR, "-B", PAYLOAD_BUILD_DIR]
    subprocess.run(cmd_cmake, check=True)
    subprocess.run([NINJA_EXE, "-C", PAYLOAD_BUILD_DIR], check=True)

def publish_artifact():
    static_dir = sanitize_path(os.path.join(BASE_DIR, "static"))
    os.makedirs(static_dir, exist_ok=True)
    
    src_wasm = os.path.join(PAYLOAD_BUILD_DIR, "transpiler.wasm")
    dst_wasm = os.path.join(static_dir, "transpiler.wasm")
    
    if os.path.exists(src_wasm):
        shutil.copy2(src_wasm, dst_wasm)
        print(f"[SYSTEM] Payload Published: {dst_wasm}")
    else:
        raise RuntimeError("Artifact compilation succeeded but binary is missing.")

if __name__ == "__main__":
    verify_hermetic_toolchain()
    print("[SYSTEM] Forging Wasi-P1 Build Matrix...")
    forge_toolchain_matrix()
    print("[SYSTEM] Hydrating Sysroot & Polyfills...")
    forge_sysroot_and_runtime()
    print("[SYSTEM] Compiling Tiered Dependencies...")
    forge_dependency_graph()
    print("[SYSTEM] Orchestrating Final Payload...")
    compile_payload()
    publish_artifact()
    print("[SYSTEM] Matrix Execution Complete. Deployment Package Armed.")