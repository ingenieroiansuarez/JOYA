// Versions are pinned on purpose (CLAUDE.md: no floating versions). They match the toolchain
// Filament 1.79.0 itself builds with (android/build.gradle at tag v1.79.0): AGP 9.4.1,
// Kotlin 2.4.0, compileSdk 37, JDK 21, Gradle 9.6.0. Filament's AARs require compileSdk >= 37.
plugins {
    id("com.android.application") version "9.4.1" apply false
    // AGP 9 compiles Kotlin itself; this only pins the Kotlin compiler version it uses.
    id("org.jetbrains.kotlin.android") version "2.4.0" apply false
}
