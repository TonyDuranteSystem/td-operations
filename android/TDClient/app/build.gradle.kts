// The client Android app "MyLLC Manager" (dev job 2c751252; docs/systems/client-app.md): a thin native shell around the portal pages,
// built to be the SAME app as the iPhone one (ios/TDClient). Two flavours, like the iPhone's Sandbox / Production:
//   sandbox    = the TEST server (td-operations-sandbox), its own app id, so a test build can never register on production
//   production = portal.tonydurante.us, the app id of the LIVE Google Play listing (com.tonydurante.app, version code above 87)
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.tonydurante.myllcmanager"
    // the newest androidx libraries (looked up 13 Nov 2026) are built against Android 37, so the app is COMPILED against 37; what it opts into at run time is targetSdk 36
    compileSdk { version = release(37) }

    defaultConfig {
        minSdk = 26
        targetSdk = 36
        versionCode = 100
        versionName = "2.0.0"
    }

    flavorDimensions += "env"
    productFlavors {
        // a test build that talks to the dev server running on this Mac (the emulator's address for the Mac is 10.0.2.2); never uploaded anywhere
        create("local") {
            dimension = "env"
            applicationId = "com.tonydurante.app.local"
            buildConfigField("String", "SERVER_URL", "\"http://10.0.2.2:3031\"")
            resValue("string", "app_name", "MyLLC (local)")
        }
        create("sandbox") {
            dimension = "env"
            applicationId = "com.tonydurante.app.sandbox"
            buildConfigField("String", "SERVER_URL", "\"https://td-operations-sandbox.vercel.app\"")
            resValue("string", "app_name", "MyLLC (sandbox)")
        }
        create("production") {
            dimension = "env"
            applicationId = "com.tonydurante.app"
            buildConfigField("String", "SERVER_URL", "\"https://portal.tonydurante.us\"")
            resValue("string", "app_name", "MyLLC Manager")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
        resValues = true
    }

    // The Google Play UPLOAD key. Nothing about it lives in the repository: the build reads the key file and its password from the environment
    // (see release-bundle.sh, which takes the password from the Mac's Keychain). Without them the release build is simply unsigned.
    val uploadStoreFile: String? = System.getenv("TD_UPLOAD_STORE_FILE")
    signingConfigs {
        if (uploadStoreFile != null) {
            create("upload") {
                storeFile = file(uploadStoreFile)
                storePassword = System.getenv("TD_UPLOAD_STORE_PASSWORD")
                keyAlias = System.getenv("TD_UPLOAD_KEY_ALIAS") ?: "upload"
                keyPassword = System.getenv("TD_UPLOAD_STORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            if (uploadStoreFile != null) signingConfig = signingConfigs.getByName("upload")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2026.09.00")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    implementation("androidx.webkit:webkit:1.18.0")

    testImplementation("junit:junit:4.13.2")
    // the real JSON reader (the one on the phone is only a stub in unit tests)
    testImplementation("org.json:json:20260814")
}
