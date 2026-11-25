plugins {
    id("com.android.application")  // AGP 9 built-in Kotlin support compiles src/main/java/**/*.kt
}

// Filament 1.79.0 (google/filament tag v1.79.0). Same version for all three artifacts.
val filamentVersion = "1.79.0"

android {
    namespace = "dev.aurea.renderbench"
    compileSdk = 37

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
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }

    // The GLB is read with openFd(), which needs it stored uncompressed.
    androidResources { noCompress += "glb" }
}

kotlin {
    jvmToolchain(21)
}

dependencies {
    implementation("com.google.android.filament:filament-android:$filamentVersion")
    implementation("com.google.android.filament:gltfio-android:$filamentVersion")
    implementation("com.google.android.filament:filament-utils-android:$filamentVersion")
}
