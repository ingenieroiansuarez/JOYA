import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Filament 1.79.0 (google/filament tag v1.79.0). Same version for all three artifacts.
val filamentVersion = "1.79.0"

android {
    namespace = "dev.aurea.renderbench"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.aurea.renderbench.poc"
        minSdk = 28
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        // Test devices are arm64 phones; keeping one ABI keeps the APK small.
        ndk { abiFilters += listOf("arm64-v8a") }
    }

    buildTypes {
        getByName("debug") { isMinifyEnabled = false }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // The GLB is read with openFd(), which needs it stored uncompressed.
    androidResources { noCompress += "glb" }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    implementation("com.google.android.filament:filament-android:$filamentVersion")
    implementation("com.google.android.filament:gltfio-android:$filamentVersion")
    implementation("com.google.android.filament:filament-utils-android:$filamentVersion")
}
