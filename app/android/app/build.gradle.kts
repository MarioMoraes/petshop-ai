plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "com.petshopai.petshop_tutor"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.petshopai.petshop_tutor"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    buildTypes {
        release {
            // TODO: Add your own signing config for the release build.
            // Signing with the debug keys for now, so `flutter run --release` works.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}

flutter {
    source = "../.."
}

// O Google Services só entra quando o `google-services.json` do projeto Firebase está
// aqui. Sem ele o plugin derruba o build — e o app precisa continuar construindo antes de
// o projeto existir: o push fica desligado (`lib/src/notificacoes.dart` engole a falha do
// `Firebase.initializeApp`) e todo o resto funciona igual. O arquivo **pode** ir para o
// git: é configuração de cliente, embarcada em todo APK, e não segredo. O segredo do push
// é a conta de serviço, e ela mora só no backend (`FCM_SERVICE_ACCOUNT_JSON_B64`).
if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}
