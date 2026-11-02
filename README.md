# JBRemote 1.1.0 — AWS EC2

Servidor: https://jbdesk.18.117.163.80.sslip.io — WebSocket: wss://jbdesk.18.117.163.80.sslip.io

Node.js 24 LTS en `/opt/jbremote-node`, una instancia PM2 en modo fork y backend privado `127.0.0.1:3001`. Nginx termina TLS en 443. El puerto antiguo 3000 solo redirige HTTP a HTTPS. El virtual host de Laravel se conserva.

El protocolo 2 requiere los clientes 1.1.0. Cada instalación genera su propia clave; los hashes de identidad se guardan fuera del checkout en `/home/ubuntu/.local/share/jbremote/identities.json`. Respaldar ese directorio con permisos restringidos. Perderlo elimina la reserva de identidades. No copiar claves de un cliente a otro.

`/health` es público. `/api/devices` requiere un `ADMIN_TOKEN` configurado en el entorno y enviado como Bearer; sin token está deshabilitado. No publicar `.env`, identidades, informes internos ni llaves en `public/`.

## Actualización

1. Comprobar espacio libre, sesiones y cambios locales. Descargar los artefactos firmados Android y portable Windows de la release y verificar `release.json`.
2. Usar `git pull --ff-only`. Conservar configuración local y backups fuera del repositorio. No usar `git reset --hard`.
3. Ejecutar `./setup-ec2.sh`. El reinicio termina sesiones existentes; actualizar en una ventana de mantenimiento.
4. Verificar `/health`, descargas, autorización y reconexión desde fuera de EC2. La aplicación no soporta varios workers sin coordinación de sesiones.

## Operación

`systemctl status pm2-ubuntu` verifica arranque al reiniciar. `systemctl list-timers certbot.timer` verifica renovación TLS. `certbot renew --dry-run` valida la renovación. Rotar logs, alertar por disco >85 % y memoria. El nombre sslip.io depende de esa IP: mantener IP estable y migrar a un dominio propio al configurar DNS.

La transferencia de archivos tiene un límite explícito de 4 MiB. WebRTC usa STUN con alternativa JPEG por WSS; redes restrictivas pueden usar la alternativa. No se promete 60 FPS ni disponibilidad del escritorio seguro/UAC. Windows portable no es un servicio de sistema.
