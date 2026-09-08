#!/bin/sh
# Eleva o teto de arquivos abertos do macOS para o `pnpm dev` do monorepo.
#
# O `turbo run dev` sobe treze processos de watch (doze backends em `tsx watch`
# mais o Next). Cada watcher segura ~1.300 descritores de diretório, o que passa
# dos 30.720 do `kern.maxfiles` padrão e derruba o dev server com
# "EMFILE: too many open files, watch".
#
# Aplica os valores agora e instala um LaunchDaemon para reaplicá-los no boot —
# o /etc/sysctl.conf não é honrado de forma confiável desde o Monterey.
#
# Uso:  sudo sh scripts/macos-maxfiles.sh
set -e

if [ "$(id -u)" -ne 0 ]; then
  echo "Rode com sudo: sudo sh scripts/macos-maxfiles.sh" >&2
  exit 1
fi

MAXFILES=524288
MAXFILESPERPROC=262144
PLIST=/Library/LaunchDaemons/limit.maxfiles.plist

sysctl -w kern.maxfiles=$MAXFILES kern.maxfilesperproc=$MAXFILESPERPROC

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>limit.maxfiles</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/sbin/sysctl</string>
      <string>-w</string>
      <string>kern.maxfiles=$MAXFILES</string>
      <string>kern.maxfilesperproc=$MAXFILESPERPROC</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>LaunchOnlyOnce</key>
    <true/>
  </dict>
</plist>
PLISTEOF

chown root:wheel "$PLIST"
chmod 644 "$PLIST"
plutil -lint "$PLIST"

# `bootstrap` é o verbo atual; `load` fica de reserva para versões antigas.
launchctl bootstrap system "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"

echo
echo "Instalado. Valores em vigor:"
sysctl kern.maxfiles kern.maxfilesperproc
