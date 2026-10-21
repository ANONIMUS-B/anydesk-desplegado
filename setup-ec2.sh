#!/usr/bin/env bash
# Script de Despliegue Rápido en AWS EC2 (Ubuntu 22.04 / 24.04 LTS)
set -e

echo "=== [1/4] Actualizando paquetes del sistema ==="
sudo apt-get update -y

echo "=== [2/4] Instalando Node.js 20 LTS ==="
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential

echo "=== [3/4] Instalando dependencias del proyecto y PM2 ==="
npm install
sudo npm install -g pm2

echo "=== [4/4] Iniciando el Servidor de Señalización con PM2 ==="
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u ubuntu --hp /home/ubuntu || true

echo "=========================================================="
echo "✅ Servidor activo en el puerto 3000."
echo "Prueba en tu navegador: http://TU_IP_EC2:3000/health"
echo "=========================================================="
