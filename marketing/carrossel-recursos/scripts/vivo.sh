#!/bin/zsh
# Entrega B (vivo), de ponta a ponta, a partir dos slides com seek(t) e dos PNGs aprovados em resultados/estatico/.
# Uso (de dentro da pasta do projeto): zsh scripts/vivo.sh [all|02,03]
set -e
SL=${1:-all}
node scripts/render.mjs cues                       # audio/beats.json com duração e acertos de cada slide
python3 scripts/musica.py                          # audio/slide-NN.wav em -14 LUFS, loop circular
node scripts/render.mjs video $SL                  # resultados/slide-NN.mp4 + resultados/quadros/slide-NN/
mkdir -p resultados/folhas
for d in resultados/quadros/slide-*; do n=$(basename $d); python3 scripts/folha-batidas.py $d resultados/folhas/$n-batidas.jpg; done
python3 scripts/testes-vivo.py                     # resultados/testes.json + resultados/testes/*.jpg (quadro 0 = PNG, loop, som)
python3 scripts/preview.py
echo "vivo pronto: resultados/slide-NN.mp4 · resultados/folhas/ · resultados/testes/ · preview.html"
