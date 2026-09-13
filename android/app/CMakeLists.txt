# S5 内嵌后端：JNI/CMake 桥接，把 libnode.so 链进 APK。
# 参考：nodejs-mobile 官方 getting-started（android native apps）
cmake_minimum_required(VERSION 3.22.1)
project(tavernnode)

# Node 24 的头文件使用 C++20 concepts（cppgc/conditional-stack-allocated.h），
# 默认标准会报 unknown type name 'concept'。
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# native-lib.cpp 位于 app/src/main/cpp/
add_library(tavernnode SHARED src/main/cpp/native-lib.cpp)

# libnode 预编译头（nodejs-mobile 官方发布包内的 include/）
include_directories(libnode/include/node/)

# 各 ABI 的 libnode.so
add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES IMPORTED_LOCATION
    ${CMAKE_SOURCE_DIR}/libnode/bin/${ANDROID_ABI}/libnode.so)

find_library(log-lib log)

target_link_libraries(tavernnode libnode ${log-lib})

# 16KB 页面大小：Android 15+ 起支持 16KB 页面，不满足 16384 对齐的原生库在
# 16KB 设备上加载即失败。libnode.so / libc++_shared.so 由预编译包提供且已对齐，
# 这里只需保证本工程产出的 libtavernnode.so 也按 16KB 对齐。
# 校验门禁：scripts/check-page-align.mjs
# 注意：NDK r27 的 clang 默认 p_align 仍为 4096，需显式指定 max-page-size。
target_link_options(tavernnode PRIVATE "-Wl,-z,max-page-size=16384")
