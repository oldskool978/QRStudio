cmake_minimum_required(VERSION 3.13)
project(QRTranspiler CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(transpiler transpiler_core.cpp)

target_link_directories(transpiler PRIVATE ${CMAKE_SYSROOT}/lib)

target_link_libraries(transpiler PRIVATE ZXing z)

target_link_options(transpiler PRIVATE
    "-mexec-model=reactor"
    "-Wl,--allow-undefined"
    "-Wl,--gc-sections"
    "-Wl,--lto-O3"
    "-Wl,--strip-all"
)

set_target_properties(transpiler PROPERTIES 
    SUFFIX ".wasm"
)