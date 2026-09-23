package com.petshopai.petshop_tutor

import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import android.os.Bundle
import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        criarCanalDeAvisos()
    }

    /**
     * O canal dos avisos do petshop (etapa 9 — push).
     *
     * Do Android 8 em diante toda notificação pertence a um canal, e é o nome dele que a
     * pessoa vê nas configurações do app para ligar ou desligar. Sem este canal, o aviso
     * cai no "Diversos" que o Firebase cria sozinho — e desligar "Diversos" não diz a
     * ninguém o que está desligando. O id `avisos` é o que o backend manda em
     * `android.notification.channel_id` (`ports/push.ts`).
     *
     * Aqui, e não num plugin de notificação local: é a única coisa nativa de que o push
     * precisa, e criar um canal que já existe não faz nada.
     */
    private fun criarCanalDeAvisos() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val canal = NotificationChannel(
            "avisos",
            "Avisos do petshop",
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "Horários, leva-e-traz, pet pronto e sua conta."
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(canal)
    }
}
