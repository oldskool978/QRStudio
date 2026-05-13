cmake_minimum_required(VERSION 3.10)
project(QRTranspiler CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Explicitly resolve the flattened sysroot library path
link_directories(${CMAKE_SYSROOT}/lib)

add_executable(transpiler transpiler_core.cpp)

target_link_libraries(transpiler PRIVATE ZXing z)

# SUPREMACY FIX: Eradicate --export-dynamic. Enforce strict GC, LTO phase 3, and binary stripping.
set_target_properties(transpiler PROPERTIES 
    LINK_FLAGS "-mexec-model=reactor -Wl,--allow-undefined -Wl,--gc-sections -Wl,--lto-O3 -Wl,--strip-all"
    SUFFIX ".wasm"
)