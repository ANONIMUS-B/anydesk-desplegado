# JBDesk Signaling & Relay Server — AWS EC2

Servidor central de señalización WebSocket y retransmisión en tiempo real para control remoto estilo AnyDesk.

---

## 🚀 Despliegue Rápido en AWS EC2 (Ubuntu 22.04 / 24.04 LTS)

### Paso 1: Clonar este repositorio en tu instancia EC2
```bash
git clone https://github.com/ANONIMUS-B/anydesk-desplegado.git
cd anydesk-desplegado
```

### Paso 2: Ejecutar el instalador automático
```bash
chmod +x setup-ec2.sh
./setup-ec2.sh
```

El script se encargará de instalar Node.js 20, dependencias, PM2 y arrancar el servidor en el puerto 3000 con reinicio automático ante caídas.

---

## 🛠️ Ejecución Manual (Alternativa)
```bash
npm install
PORT=3000 node server.js
```

O en segundo plano con PM2:
```bash
sudo npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
```

---

## 🌐 Comprobar Funcionamiento
Abre en tu navegador o mediante curl:
```bash
curl http://localhost:3000/health
```
Respuesta esperada:
```json
{
  "status": "online",
  "service": "JBRemote Enterprise Cloud Engine (cPanel)",
  "version": "1.0.0",
  "devices_online": 0,
  "active_sessions": 0
}
```

---

## 🔒 Reglas de Seguridad en AWS (Inbound Rules)
Asegúrate de que el Security Group de tu EC2 tenga abierto:
- **Puerto 22 (TCP):** SSH
- **Puerto 3000 (TCP):** Servidor WebSocket / HTTP directo
- **Puerto 80 / 443 (TCP):** Si configuras Nginx con dominio y SSL

